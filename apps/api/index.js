import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { parse } from 'csv-parse/sync'
import pkg from 'pg'
const { Pool } = pkg

const app = express()
const PORT = 3000

// Validate required environment variables
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN
if (!MAPBOX_TOKEN) {
  console.error('ERROR: MAPBOX_TOKEN environment variable is required')
  process.exit(1)
}

// CORS configuration
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173'
app.use(cors({
  origin: CORS_ORIGIN,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}))
app.use(express.json())

// Database connection - must use DATABASE_URL
const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required')
  process.exit(1)
}

// Parse DATABASE_URL (format: postgresql://user:password@host:port/database)
let dbConfig
try {
  const url = new URL(DATABASE_URL)
  dbConfig = {
    host: url.hostname,
    port: parseInt(url.port) || 5432,
    database: url.pathname.slice(1), // Remove leading '/'
    user: url.username,
    password: url.password
  }
  
  // Log connection info (no password)
  console.log(`Database connection: ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`)
} catch (error) {
  console.error('ERROR: Invalid DATABASE_URL format:', error.message)
  process.exit(1)
}

const pool = new Pool(dbConfig)

// Configure multer for file uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
})

app.get('/health', (req, res) => {
  res.json({ ok: true })
})

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' })
    }

    // Check if file is CSV
    const fileExtension = req.file.originalname.split('.').pop()?.toLowerCase()
    if (fileExtension !== 'csv') {
      return res.status(400).json({ error: 'File must be a CSV' })
    }

    // Parse CSV
    let records
    try {
      records = parse(req.file.buffer.toString('utf-8'), {
        columns: true,
        skip_empty_lines: true,
        trim: true
      })
    } catch (parseError) {
      return res.status(400).json({ error: 'Invalid CSV format', details: parseError.message })
    }

    if (records.length === 0) {
      return res.status(400).json({ error: 'CSV file is empty' })
    }

    // Validate required columns
    const headers = Object.keys(records[0])
    const hasAddress = headers.includes('address')
    const hasStreet = headers.includes('street')
    const hasCity = headers.includes('city')
    const hasPostal = headers.includes('postal')

    if (!hasAddress && (!hasStreet || !hasCity || !hasPostal)) {
      return res.status(400).json({ 
        error: 'Missing required columns. Must have either "address" OR all of "street", "city", "postal"' 
      })
    }

    // Create upload record
    const uploadResult = await pool.query(
      'INSERT INTO uploads (original_filename, status) VALUES ($1, $2) RETURNING id',
      [req.file.originalname, 'uploaded']
    )
    const uploadId = uploadResult.rows[0].id

    let validRows = 0
    let invalidRows = 0

    // Process each row
    for (let i = 0; i < records.length; i++) {
      const row = records[i]
      
      // Build raw_address
      let rawAddress = ''
      if (hasAddress) {
        rawAddress = (row.address || '').trim()
      } else {
        const street = (row.street || '').trim()
        const city = (row.city || '').trim()
        const postal = (row.postal || '').trim()
        rawAddress = [street, city, postal].filter(Boolean).join(', ')
      }

      // Skip if raw_address is empty
      if (!rawAddress) {
        invalidRows++
        continue
      }

      // Insert row
      await pool.query(
        `INSERT INTO upload_rows (
          upload_id, row_index, raw_address, 
          service_type, customer_count, revenue_bucket
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          uploadId,
          i + 1, // row_index is 1-based
          rawAddress,
          row.service_type || null,
          row.customer_count ? parseInt(row.customer_count) : null,
          row.revenue_bucket || null
        ]
      )
      validRows++
    }

    // Update upload record with counts
    await pool.query(
      'UPDATE uploads SET total_rows = $1, valid_rows = $2, invalid_rows = $3 WHERE id = $4',
      [records.length, validRows, invalidRows, uploadId]
    )

    res.json({
      uploadId,
      totalRows: records.length,
      validRows,
      invalidRows
    })
  } catch (error) {
    console.error('Upload error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

// Helper function to geocode an address using Mapbox
async function geocodeAddress(address) {
  const encodedAddress = encodeURIComponent(address)
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodedAddress}.json?access_token=${MAPBOX_TOKEN}&limit=1`
  
  try {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Mapbox API error: ${response.status} ${response.statusText}`)
    }
    
    const data = await response.json()
    
    if (data.features && data.features.length > 0) {
      const feature = data.features[0]
      const [lng, lat] = feature.center
      return { lat, lng, success: true }
    } else {
      return { success: false, error: 'no result' }
    }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

// Helper function to delay execution
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// Helper function to reverse geocode a location (area-style labels only)
async function reverseGeocode(lat, lng) {
  try {
    // Request multiple results to find best area-type match
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${MAPBOX_TOKEN}&limit=5`
    const response = await fetch(url)
    
    if (!response.ok) {
      throw new Error(`Mapbox API error: ${response.status}`)
    }
    
    const data = await response.json()
    
    if (data.features && data.features.length > 0) {
      // Priority order: neighborhood, locality, place, district, region
      const priorityTypes = ['neighborhood', 'locality', 'place', 'district', 'region']
      
      // Find first feature matching priority types
      for (const type of priorityTypes) {
        const feature = data.features.find(f => 
          f.place_type && f.place_type.includes(type)
        )
        if (feature) {
          // Return a clean area label (no street addresses)
          const context = feature.context || []
          const placeName = feature.text
          const locality = context.find(c => c.id?.startsWith('locality'))?.text
          const region = context.find(c => c.id?.startsWith('region'))?.text
          
          if (locality && placeName !== locality) {
            return `${placeName} / ${locality}`
          } else if (region && placeName !== region) {
            return `${placeName} / ${region}`
          }
          return placeName || feature.place_name?.split(',')[0] || `${lat.toFixed(2)}, ${lng.toFixed(2)}`
        }
      }
      
      // Fallback: use first feature's text if it's not an address
      const firstFeature = data.features[0]
      if (!firstFeature.place_type?.includes('address')) {
        return firstFeature.text || `${lat.toFixed(2)}, ${lng.toFixed(2)}`
      }
    }
    
    // Final fallback
    return `Near ${lat.toFixed(2)}, ${lng.toFixed(2)}`
  } catch (error) {
    console.error('Reverse geocode error:', error)
    return `Near ${lat.toFixed(2)}, ${lng.toFixed(2)}`
  }
}

app.post('/api/uploads/:id/geocode', async (req, res) => {
  const uploadId = req.params.id
  
  try {
    // Verify upload exists
    const uploadCheck = await pool.query('SELECT id FROM uploads WHERE id = $1', [uploadId])
    if (uploadCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Upload not found' })
    }

    // Set status to processing
    await pool.query('UPDATE uploads SET status = $1 WHERE id = $2', ['processing', uploadId])

    // Return immediately (async processing)
    res.json({ started: true })

    // Fetch all pending rows
    const rowsResult = await pool.query(
      'SELECT id, raw_address FROM upload_rows WHERE upload_id = $1 AND geocode_status = $2',
      [uploadId, 'pending']
    )
    const rows = rowsResult.rows

    if (rows.length === 0) {
      await pool.query('UPDATE uploads SET status = $1 WHERE id = $2', ['done', uploadId])
      return
    }

    let successCount = 0
    let failedCount = 0

    // Process in batches of 10
    const batchSize = 10
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize)
      
      // Process batch in parallel
      const batchPromises = batch.map(async (row) => {
        const result = await geocodeAddress(row.raw_address)
        
        if (result.success) {
          // Update with success: lat, lng, geom, status
          await pool.query(
            `UPDATE upload_rows 
             SET lat = $1, lng = $2, 
                 geom = ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
                 geocode_status = $3, geocode_error = NULL
             WHERE id = $4`,
            [result.lat, result.lng, 'success', row.id]
          )
          successCount++
        } else {
          // Update with failure
          await pool.query(
            'UPDATE upload_rows SET geocode_status = $1, geocode_error = $2 WHERE id = $3',
            ['failed', result.error, row.id]
          )
          failedCount++
        }
      })
      
      await Promise.all(batchPromises)
      
      // Delay between batches (except for the last batch)
      if (i + batchSize < rows.length) {
        await delay(200)
      }
    }

    // Update upload status
    const finalStatus = successCount > 0 ? 'done' : 'failed'
    await pool.query('UPDATE uploads SET status = $1 WHERE id = $2', [finalStatus, uploadId])

    console.log(`Geocoding completed for upload ${uploadId}: ${successCount} success, ${failedCount} failed`)
  } catch (error) {
    console.error('Geocoding error:', error)
    // Set upload status to failed on error
    await pool.query('UPDATE uploads SET status = $1 WHERE id = $2', ['failed', uploadId])
  }
})

app.get('/api/uploads/:id', async (req, res) => {
  const uploadId = req.params.id
  
  try {
    const result = await pool.query(
      'SELECT id, status, total_rows, valid_rows, invalid_rows FROM uploads WHERE id = $1',
      [uploadId]
    )
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Upload not found' })
    }
    
    res.json(result.rows[0])
  } catch (error) {
    console.error('Error fetching upload:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

app.get('/api/uploads/:id/points', async (req, res) => {
  const uploadId = req.params.id
  
  try {
    const result = await pool.query(
      `SELECT id, lat, lng 
       FROM upload_rows 
       WHERE upload_id = $1 AND geocode_status = 'success' AND lat IS NOT NULL AND lng IS NOT NULL
       ORDER BY row_index`,
      [uploadId]
    )
    
    res.json(result.rows)
  } catch (error) {
    console.error('Error fetching points:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

app.get('/api/uploads/:id/insights', async (req, res) => {
  const uploadId = req.params.id
  
  try {
    // Get top 3 dense areas (grid cells rounded to 2 decimals)
    const denseAreasResult = await pool.query(
      `WITH grid_cells AS (
        SELECT 
          ROUND(lat::numeric, 2) as cell_lat,
          ROUND(lng::numeric, 2) as cell_lng,
          COUNT(*) as count,
          AVG(lat) as center_lat,
          AVG(lng) as center_lng,
          COALESCE(SUM(customer_count), 0) as total_customers
        FROM upload_rows
        WHERE upload_id = $1 
          AND geocode_status = 'success' 
          AND lat IS NOT NULL 
          AND lng IS NOT NULL
        GROUP BY ROUND(lat::numeric, 2), ROUND(lng::numeric, 2)
      )
      SELECT 
        cell_lat || ',' || cell_lng as cell_id,
        count,
        center_lat as lat,
        center_lng as lng,
        total_customers
      FROM grid_cells
      ORDER BY count DESC
      LIMIT 3`,
      [uploadId]
    )

    // Reverse geocode cache to avoid duplicate calls
    const geocodeCache = new Map()
    
    const getLabel = async (lat, lng) => {
      const key = `${lat.toFixed(2)},${lng.toFixed(2)}`
      if (geocodeCache.has(key)) {
        return geocodeCache.get(key)
      }
      const label = await reverseGeocode(lat, lng)
      geocodeCache.set(key, label)
      return label
    }

    // Get labels for dense areas
    const topDenseAreas = await Promise.all(
      denseAreasResult.rows.map(async (row) => {
        const lat = parseFloat(row.lat)
        const lng = parseFloat(row.lng)
        const label = await getLabel(lat, lng)
        
        return {
          cellId: row.cell_id,
          count: parseInt(row.count),
          center: {
            lat,
            lng
          },
          label
        }
      })
    )

    // Calculate concentration percent
    const totalCustomersResult = await pool.query(
      `SELECT COALESCE(SUM(customer_count), 0) as total
       FROM upload_rows
       WHERE upload_id = $1 AND geocode_status = 'success' AND customer_count IS NOT NULL`,
      [uploadId]
    )
    const totalCustomers = parseInt(totalCustomersResult.rows[0].total) || 0

    const customersInTop3 = denseAreasResult.rows.reduce((sum, row) => sum + parseInt(row.total_customers || 0), 0)
    const concentrationPercent = totalCustomers > 0 
      ? Math.round((customersInTop3 / totalCustomers) * 100) 
      : 0

    // Get white space areas (cells with 0-1 count within 3km of dense cells)
    let whiteSpaceAreas = []
    
    if (topDenseAreas.length > 0) {
      // Build dense centers for distance calculation
      const denseCenters = topDenseAreas.map(area => ({
        lat: area.center.lat,
        lng: area.center.lng
      }))

      // Get all grid cells with low counts (0-1) and calculate distance to nearest dense cell
      const whiteSpaceQuery = `
        WITH dense_cells AS (
          SELECT 
            ROUND(lat::numeric, 2) as cell_lat,
            ROUND(lng::numeric, 2) as cell_lng,
            AVG(lat) as center_lat,
            AVG(lng) as center_lng
          FROM upload_rows
          WHERE upload_id = $1 
            AND geocode_status = 'success' 
            AND lat IS NOT NULL 
            AND lng IS NOT NULL
          GROUP BY ROUND(lat::numeric, 2), ROUND(lng::numeric, 2)
          ORDER BY COUNT(*) DESC
          LIMIT 3
        ),
        all_cells AS (
          SELECT 
            ROUND(lat::numeric, 2) as cell_lat,
            ROUND(lng::numeric, 2) as cell_lng,
            COUNT(*) as count,
            AVG(lat) as center_lat,
            AVG(lng) as center_lng
          FROM upload_rows
          WHERE upload_id = $1 
            AND geocode_status = 'success' 
            AND lat IS NOT NULL 
            AND lng IS NOT NULL
          GROUP BY ROUND(lat::numeric, 2), ROUND(lng::numeric, 2)
        ),
        whitespace_candidates AS (
          SELECT 
            ac.cell_lat,
            ac.cell_lng,
            ac.count,
            ac.center_lat,
            ac.center_lng,
            MIN(
              ST_Distance(
                ST_SetSRID(ST_MakePoint(ac.center_lng, ac.center_lat), 4326)::geography,
                ST_SetSRID(ST_MakePoint(dc.center_lng, dc.center_lat), 4326)::geography
              ) / 1000.0
            ) as distance_km
          FROM all_cells ac
          CROSS JOIN dense_cells dc
          WHERE ac.count <= 1
            AND NOT EXISTS (
              SELECT 1 FROM dense_cells dc2 
              WHERE dc2.cell_lat = ac.cell_lat AND dc2.cell_lng = ac.cell_lng
            )
          GROUP BY ac.cell_lat, ac.cell_lng, ac.count, ac.center_lat, ac.center_lng
          HAVING MIN(
            ST_Distance(
              ST_SetSRID(ST_MakePoint(ac.center_lng, ac.center_lat), 4326)::geography,
              ST_SetSRID(ST_MakePoint(dc.center_lng, dc.center_lat), 4326)::geography
            ) / 1000.0
          ) <= 3
        )
        SELECT 
          cell_lat || ',' || cell_lng as cell_id,
          count,
          center_lat as lat,
          center_lng as lng,
          distance_km
        FROM whitespace_candidates
        ORDER BY distance_km ASC
        LIMIT 3`

      const whiteSpaceResult = await pool.query(whiteSpaceQuery, [uploadId])
      
      // Get labels for white space areas
      whiteSpaceAreas = await Promise.all(
        whiteSpaceResult.rows.map(async (row) => {
          const lat = parseFloat(row.lat)
          const lng = parseFloat(row.lng)
          const label = await getLabel(lat, lng)
          
          return {
            cellId: row.cell_id,
            count: parseInt(row.count),
            center: {
              lat,
              lng
            },
            distanceKm: Math.round(parseFloat(row.distance_km) * 10) / 10, // Round to 1 decimal
            label
          }
        })
      )
    }

    res.json({
      topDenseAreas,
      concentrationPercent,
      whiteSpaceAreas
    })
  } catch (error) {
    console.error('Error fetching insights:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})


