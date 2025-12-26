import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import html2canvas from 'html2canvas'

// Get API base URL from environment or default to localhost
const getApiBaseUrl = () => {
  const envUrl = import.meta.env.VITE_API_URL
  if (envUrl) {
    // Remove trailing slash if present
    return envUrl.replace(/\/$/, '')
  }
  return 'http://localhost:3000'
}

const API_BASE = getApiBaseUrl()

function App() {
  const mapContainer = useRef(null)
  const map = useRef(null)
  const fileInputRef = useRef(null)
  
  const [uploadId, setUploadId] = useState(null)
  const [uploadStats, setUploadStats] = useState(null)
  const [status, setStatus] = useState('idle') // idle, uploaded, processing, done, error
  const [points, setPoints] = useState([])
  const [showHeatmap, setShowHeatmap] = useState(false)
  const [insights, setInsights] = useState(null)
  const [activeHighlight, setActiveHighlight] = useState(null) // { type: 'dense'|'whitespace', center: {lat, lng}, radius: number }
  const [selectedFileName, setSelectedFileName] = useState(null)
  const [isExporting, setIsExporting] = useState(false)
  const appContainerRef = useRef(null)
  
  // Bottom sheet drag state
  const [sheetPosition, setSheetPosition] = useState(0.5) // 0.5 = 50vh, 0.8 = 80vh, 1.0 = full
  const [isDragging, setIsDragging] = useState(false)
  const [dragStartY, setDragStartY] = useState(0)
  const [dragStartPosition, setDragStartPosition] = useState(0.5)
  const sheetRef = useRef(null)

  // Initialize map
  useEffect(() => {
    if (map.current || !mapContainer.current) return

    const token = import.meta.env.VITE_MAPBOX_TOKEN
    if (!token) {
      console.error('VITE_MAPBOX_TOKEN is not set in environment variables')
      return
    }

    try {
      map.current = new mapboxgl.Map({
        container: mapContainer.current,
        style: 'mapbox://styles/mapbox/dark-v11', // Dark map style
        center: [-122.4194, 37.7749], // San Francisco
        zoom: 12,
        accessToken: token,
        preserveDrawingBuffer: true // Required for canvas export
      })

      map.current.on('load', () => {
        // Add empty source and layers for points
        if (!map.current.getSource('geocoded-points')) {
          map.current.addSource('geocoded-points', {
            type: 'geojson',
            data: {
              type: 'FeatureCollection',
              features: []
            }
          })

          // Add heatmap layer first (initially hidden)
          map.current.addLayer({
            id: 'geocoded-heatmap-layer',
            type: 'heatmap',
            source: 'geocoded-points',
            maxzoom: 15,
            paint: {
              'heatmap-weight': 1,
              'heatmap-intensity': 1,
              'heatmap-color': [
                'interpolate',
                ['linear'],
                ['heatmap-density'],
                0, 'rgba(59, 130, 246, 0)',
                0.2, 'rgba(59, 130, 246, 0.5)',
                0.4, 'rgba(59, 130, 246, 0.8)',
                0.6, 'rgba(147, 51, 234, 0.8)',
                0.8, 'rgba(236, 72, 153, 0.8)',
                1, 'rgba(239, 68, 68, 1)'
              ],
              'heatmap-radius': 30,
              'heatmap-opacity': 0.6
            }
          })

          // Add circle layer
          map.current.addLayer({
            id: 'geocoded-points-layer',
            type: 'circle',
            source: 'geocoded-points',
            paint: {
              'circle-radius': 8,
              'circle-color': '#3b82f6',
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff'
            }
          })

          // Initially hide heatmap layer
          map.current.setLayoutProperty('geocoded-heatmap-layer', 'visibility', 'none')

          // Add circle highlight source and layers
          map.current.addSource('highlight-circle', {
            type: 'geojson',
            data: {
              type: 'FeatureCollection',
              features: []
            }
          })

          // Circle fill layer
          map.current.addLayer({
            id: 'highlight-circle-fill',
            type: 'fill',
            source: 'highlight-circle',
            paint: {
              'fill-color': '#3b82f6',
              'fill-opacity': 0.1
            }
          })

          // Circle outline layer
          map.current.addLayer({
            id: 'highlight-circle-outline',
            type: 'line',
            source: 'highlight-circle',
            paint: {
              'line-color': '#60a5fa',
              'line-width': 2,
              'line-opacity': 0.8
            }
          })
        }
      })
    } catch (error) {
      console.error('Error initializing Mapbox:', error)
    }
  }, [])

  // Update map when points change
  useEffect(() => {
    if (!map.current || !map.current.getSource('geocoded-points')) return

    const source = map.current.getSource('geocoded-points')
    if (source) {
      source.setData({
        type: 'FeatureCollection',
        features: points.map(point => ({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [point.lng, point.lat]
          },
          properties: { id: point.id }
        }))
      })

      // Fit map to bounds if we have points
      if (points.length > 0) {
        const bounds = new mapboxgl.LngLatBounds()
        points.forEach(point => {
          bounds.extend([point.lng, point.lat])
        })
        map.current.fitBounds(bounds, { padding: 50 })
      }
    }
  }, [points])

  // Toggle between circle and heatmap layers
  useEffect(() => {
    if (!map.current) return

    if (map.current.getLayer('geocoded-points-layer') && map.current.getLayer('geocoded-heatmap-layer')) {
      if (showHeatmap) {
        map.current.setLayoutProperty('geocoded-points-layer', 'visibility', 'none')
        map.current.setLayoutProperty('geocoded-heatmap-layer', 'visibility', 'visible')
      } else {
        map.current.setLayoutProperty('geocoded-points-layer', 'visibility', 'visible')
        map.current.setLayoutProperty('geocoded-heatmap-layer', 'visibility', 'none')
      }
    }
  }, [showHeatmap])

  // Update highlight circle when activeHighlight changes
  useEffect(() => {
    if (!map.current || !map.current.getSource('highlight-circle')) return

    const source = map.current.getSource('highlight-circle')
    
    if (activeHighlight) {
      // Create a circle polygon with proper geodesic calculation
      const center = [activeHighlight.center.lng, activeHighlight.center.lat]
      const radiusKm = activeHighlight.radius
      const radiusMeters = radiusKm * 1000
      
      // Create circle with proper geodesic calculation
      const steps = 64
      const circle = []
      const centerLatRad = (activeHighlight.center.lat * Math.PI) / 180
      const centerLngRad = (activeHighlight.center.lng * Math.PI) / 180
      
      // Earth's radius in meters
      const earthRadius = 6371000
      const angularRadius = radiusMeters / earthRadius
      
      for (let i = 0; i <= steps; i++) {
        const angle = (i * 2 * Math.PI) / steps
        const latRad = Math.asin(
          Math.sin(centerLatRad) * Math.cos(angularRadius) +
          Math.cos(centerLatRad) * Math.sin(angularRadius) * Math.cos(angle)
        )
        const lngRad = centerLngRad + Math.atan2(
          Math.sin(angle) * Math.sin(angularRadius) * Math.cos(centerLatRad),
          Math.cos(angularRadius) - Math.sin(centerLatRad) * Math.sin(latRad)
        )
        
        circle.push([(lngRad * 180) / Math.PI, (latRad * 180) / Math.PI])
      }
      circle.push(circle[0]) // Close the polygon

      source.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [circle]
          }
        }]
      })

      // Fly to location with appropriate zoom based on radius
      const zoomLevel = radiusKm <= 1 ? 14 : radiusKm <= 2 ? 13 : 12
      map.current.flyTo({
        center: center,
        zoom: zoomLevel,
        duration: 1000
      })
    } else {
      // Clear circle
      source.setData({
        type: 'FeatureCollection',
        features: []
      })
    }
  }, [activeHighlight])

  const handleFileChange = (e) => {
    // Reset state when new file selected
    if (e.target.files.length > 0) {
      setSelectedFileName(e.target.files[0].name)
      setUploadId(null)
      setUploadStats(null)
      setStatus('idle')
      setPoints([])
      setInsights(null)
      setSheetPosition(0.5)
      setActiveHighlight(null)
    } else {
      setSelectedFileName(null)
    }
  }

  const handleUpload = async () => {
    const file = fileInputRef.current?.files[0]
    if (!file) {
      alert('Please select a CSV file')
      return
    }

    const formData = new FormData()
    formData.append('file', file)

    try {
      setStatus('uploaded')
      const response = await fetch(`${API_BASE}/api/upload`, {
        method: 'POST',
        body: formData
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Upload failed')
      }

      const data = await response.json()
      setUploadId(data.uploadId)
      setUploadStats({
        totalRows: data.totalRows,
        validRows: data.validRows,
        invalidRows: data.invalidRows
      })
      setStatus('uploaded')
    } catch (error) {
      console.error('Upload error:', error)
      setStatus('error')
      alert(`Upload failed: ${error.message}`)
    }
  }

  const handleGeocode = async () => {
    if (!uploadId) return

    try {
      setStatus('processing')
      const response = await fetch(`${API_BASE}/api/uploads/${uploadId}/geocode`, {
        method: 'POST'
      })

      if (!response.ok) {
        throw new Error('Geocoding request failed')
      }

      // Poll for completion
      const pollInterval = setInterval(async () => {
        try {
          const statusResponse = await fetch(`${API_BASE}/api/uploads/${uploadId}/points`)
          if (statusResponse.ok) {
            const pointsData = await statusResponse.json()
            
            // Check upload status
            const uploadResponse = await fetch(`${API_BASE}/api/uploads/${uploadId}`)
            if (uploadResponse.ok) {
              const uploadData = await uploadResponse.json()
              
              if (uploadData.status === 'done' || uploadData.status === 'failed') {
                clearInterval(pollInterval)
                setStatus(uploadData.status === 'done' ? 'done' : 'error')
                setPoints(pointsData)
                
                // Fetch insights when geocoding completes
                if (uploadData.status === 'done') {
                  fetchInsights(uploadId)
                }
              }
            }
          }
        } catch (error) {
          console.error('Polling error:', error)
        }
      }, 2000) // Poll every 2 seconds

      // Stop polling after 5 minutes
      setTimeout(() => clearInterval(pollInterval), 300000)
    } catch (error) {
      console.error('Geocoding error:', error)
      setStatus('error')
      alert(`Geocoding failed: ${error.message}`)
    }
  }

  const fetchInsights = async (id) => {
    try {
      const response = await fetch(`${API_BASE}/api/uploads/${id}/insights`)
      if (response.ok) {
        const data = await response.json()
        setInsights(data)
      }
    } catch (error) {
      console.error('Error fetching insights:', error)
    }
  }

  const getStatusText = () => {
    switch (status) {
      case 'idle': return 'Idle'
      case 'uploaded': return 'Uploaded'
      case 'processing': return 'Processing...'
      case 'done': return 'Done'
      case 'error': return 'Error'
      default: return 'Idle'
    }
  }

  const handleExportPNG = async () => {
    if (isExporting) return
    
    setIsExporting(true)
    
    try {
      // Wait a brief moment to ensure UI is ready
      await new Promise(resolve => setTimeout(resolve, 100))
      
      // Capture the entire app container
      const container = appContainerRef.current || document.body
      
      const canvas = await html2canvas(container, {
        useCORS: true,
        allowTaint: false,
        backgroundColor: '#0a0a0a',
        scale: 1,
        logging: false,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight
      })
      
      // Convert to blob and download
      canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          
          // Generate filename with timestamp
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
          link.download = `arealens-export-${timestamp}.png`
          
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          
          // Clean up
          setTimeout(() => URL.revokeObjectURL(url), 100)
        }
      }, 'image/png')
    } catch (error) {
      console.error('Export error:', error)
      alert('Failed to export PNG. Please try again.')
    } finally {
      setIsExporting(false)
    }
  }

  const topBarHeight = 64
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 1000
  const maxSheetHeight = viewportHeight - topBarHeight

  // Calculate snap points (as fractions of viewport)
  const snapPoints = [0.5, 0.8, 1.0] // 50vh, 80vh, full

  // Handle drag start
  const handleDragStart = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
    setDragStartY(e.clientY || e.touches?.[0]?.clientY)
    setDragStartPosition(sheetPosition)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'grabbing'
  }

  // Set up global pointer event listeners
  useEffect(() => {
    if (!isDragging) {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      return
    }

    const handleMove = (e) => {
      e.preventDefault()
      e.stopPropagation()
      
      const currentY = e.clientY || e.touches?.[0]?.clientY
      const deltaY = dragStartY - currentY
      const deltaPercent = deltaY / viewportHeight
      
      let newPosition = dragStartPosition + deltaPercent
      newPosition = Math.max(0, Math.min(1, newPosition))
      
      setSheetPosition(newPosition)
    }

    const handleEnd = (e) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      
      // Find nearest snap point
      const currentHeight = sheetPosition * maxSheetHeight
      let nearestSnap = snapPoints[0]
      let minDistance = Math.abs(currentHeight - (nearestSnap * maxSheetHeight))
      
      for (const snap of snapPoints) {
        const distance = Math.abs(currentHeight - (snap * maxSheetHeight))
        if (distance < minDistance) {
          minDistance = distance
          nearestSnap = snap
        }
      }
      
      // Only snap if movement was significant (threshold: 20px)
      const movement = Math.abs((sheetPosition - dragStartPosition) * maxSheetHeight)
      if (movement < 20) {
        setSheetPosition(dragStartPosition)
      } else {
        setSheetPosition(nearestSnap)
      }
    }

    window.addEventListener('pointermove', handleMove, { passive: false })
    window.addEventListener('pointerup', handleEnd, { passive: false })
    window.addEventListener('touchmove', handleMove, { passive: false })
    window.addEventListener('touchend', handleEnd, { passive: false })

    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('touchmove', handleMove)
      window.removeEventListener('touchend', handleEnd)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [isDragging, dragStartY, dragStartPosition, sheetPosition, maxSheetHeight, viewportHeight, snapPoints])

  // Calculate sheet height and translateY
  const sheetHeight = sheetPosition * maxSheetHeight
  const translateY = maxSheetHeight - sheetHeight // Translate from bottom
  const isFull = sheetPosition >= 0.99
  const handleHeight = 48 // Height of the handle area (12px padding top + 12px bottom + 24px for handle)

  return (
    <div ref={appContainerRef} style={{ position: 'relative', width: '100%', height: '100vh', overflow: 'hidden', backgroundColor: '#0a0a0a' }}>
      {/* Full-screen Map */}
      <div 
        ref={mapContainer} 
        style={{ 
          width: '100%', 
          height: '100%',
          opacity: isFull ? 0 : 1,
          transition: isDragging ? 'none' : 'opacity 0.3s ease'
        }} 
      />

      {/* Top Overlay Bar */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: `${topBarHeight}px`,
        padding: '0 20px',
        backgroundColor: 'rgba(20, 20, 20, 0.85)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px'
      }}>
        {/* Left Zone: Choose CSV + Upload + Filename */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <label style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '8px 20px',
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            border: '2px dashed rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            color: '#e5e7eb',
            fontSize: '14px',
            fontWeight: '600',
            cursor: 'pointer',
            transition: 'all 0.2s',
            height: '36px',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)'
          }}
          onMouseOver={(e) => {
            e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.08)'
            e.target.style.borderColor = 'rgba(255, 255, 255, 0.3)'
          }}
          onMouseOut={(e) => {
            e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.05)'
            e.target.style.borderColor = 'rgba(255, 255, 255, 0.2)'
          }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            Choose CSV
          </label>

          {selectedFileName ? (
            <div style={{
              padding: '6px 12px',
              backgroundColor: 'transparent',
              border: '1px solid rgba(59, 130, 246, 0.4)',
              borderRadius: '16px',
              fontSize: '13px',
              color: '#60a5fa',
              height: '36px',
              display: 'flex',
              alignItems: 'center',
              minWidth: '140px',
              maxWidth: '250px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
            title={selectedFileName}
            >
              {selectedFileName}
            </div>
          ) : (
            <div style={{
              padding: '6px 12px',
              fontSize: '13px',
              color: '#6b7280',
              height: '36px',
              display: 'flex',
              alignItems: 'center'
            }}>
              No file selected
            </div>
          )}

          <button
            onClick={handleUpload}
            style={{
              padding: '8px 20px',
              backgroundColor: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: '600',
              cursor: 'pointer',
              transition: 'all 0.2s',
              height: '36px'
            }}
            onMouseOver={(e) => e.target.style.backgroundColor = '#2563eb'}
            onMouseOut={(e) => e.target.style.backgroundColor = '#3b82f6'}
          >
            Upload
          </button>
        </div>

        {/* Right Zone: Heatmap + Status/Counts + Run Geocode */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {points.length > 0 && (
            <label style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 16px',
              backgroundColor: 'rgba(255, 255, 255, 0.05)',
              borderRadius: '8px',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              cursor: 'pointer',
              fontSize: '13px',
              color: '#e5e7eb',
              height: '36px'
            }}>
              <input
                type="checkbox"
                checked={showHeatmap}
                onChange={(e) => setShowHeatmap(e.target.checked)}
                style={{ cursor: 'pointer', accentColor: '#3b82f6' }}
              />
              <span>Heatmap</span>
            </label>
          )}

          <div style={{
            padding: '8px 16px',
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            borderRadius: '8px',
            fontSize: '13px',
            color: '#e5e7eb',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            height: '36px',
            display: 'flex',
            alignItems: 'center'
          }}>
            Status: <strong style={{ marginLeft: '6px', color: '#60a5fa' }}>{getStatusText()}</strong>
          </div>


          {uploadStats && (
            <div style={{
              padding: '8px 16px',
              backgroundColor: 'rgba(255, 255, 255, 0.05)',
              borderRadius: '8px',
              fontSize: '12px',
              color: '#9ca3af',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              height: '36px',
              display: 'flex',
              alignItems: 'center'
            }}>
              Total: <strong style={{ color: '#e5e7eb', marginLeft: '4px' }}>{uploadStats.totalRows}</strong>
              {' | '}Valid: <strong style={{ color: '#10b981', marginLeft: '4px' }}>{uploadStats.validRows}</strong>
              {' | '}Invalid: <strong style={{ color: '#ef4444', marginLeft: '4px' }}>{uploadStats.invalidRows}</strong>
              {points.length > 0 && (
                <> {' | '}Geocoded: <strong style={{ color: '#3b82f6', marginLeft: '4px' }}>{points.length}</strong></>
              )}
      </div>
          )}

          <button
            onClick={handleGeocode}
            disabled={!uploadId || status === 'processing'}
            style={{
              padding: '8px 20px',
              backgroundColor: uploadId && status !== 'processing' ? '#10b981' : '#4b5563',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: '600',
              cursor: uploadId && status !== 'processing' ? 'pointer' : 'not-allowed',
              transition: 'all 0.2s',
              height: '36px',
              opacity: uploadId && status !== 'processing' ? 1 : 0.6,
              boxShadow: uploadId && status !== 'processing' ? '0 2px 8px rgba(16, 185, 129, 0.3)' : 'none'
            }}
            onMouseOver={(e) => {
              if (uploadId && status !== 'processing') {
                e.target.style.backgroundColor = '#059669'
                e.target.style.boxShadow = '0 4px 12px rgba(16, 185, 129, 0.4)'
              }
            }}
            onMouseOut={(e) => {
              e.target.style.backgroundColor = uploadId && status !== 'processing' ? '#10b981' : '#4b5563'
              e.target.style.boxShadow = uploadId && status !== 'processing' ? '0 2px 8px rgba(16, 185, 129, 0.3)' : 'none'
            }}
          >
            Run Geocode
        </button>
        </div>
      </div>

      {/* Bottom Sheet */}
      {insights && (
        <div 
          ref={sheetRef}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: `${maxSheetHeight}px`,
            backgroundColor: 'rgba(15, 15, 15, 0.95)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            borderTop: '1px solid rgba(255, 255, 255, 0.1)',
            borderTopLeftRadius: '24px',
            borderTopRightRadius: '24px',
            zIndex: 1000,
            transform: `translateY(${translateY}px)`,
            transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 -4px 24px rgba(0, 0, 0, 0.5)',
            overflow: 'hidden'
          }}
        >
          {/* Handle */}
          <div
            onPointerDown={handleDragStart}
            onTouchStart={handleDragStart}
            style={{
              padding: '12px 0',
              cursor: isDragging ? 'grabbing' : 'grab',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
              touchAction: 'none',
              userSelect: 'none',
              WebkitUserSelect: 'none'
            }}
          >
            <div style={{
              width: '40px',
              height: '4px',
              backgroundColor: 'rgba(255, 255, 255, 0.3)',
              borderRadius: '2px'
            }} />
          </div>

          {/* Content */}
          <div 
            style={{
              flex: '1 1 auto',
              padding: '24px',
              overflowY: 'auto',
              overflowX: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              gap: '24px',
              minHeight: 0,
              maxHeight: `${sheetHeight - handleHeight}px`,
              touchAction: 'pan-y',
              WebkitOverflowScrolling: 'touch'
            }}
            onPointerDown={(e) => {
              // Prevent drag when clicking inside content
              e.stopPropagation()
            }}
          >
            {/* Header */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '8px'
            }}>
              <h2 style={{
                margin: 0,
                fontSize: '24px',
                fontWeight: '700',
                color: '#ffffff'
              }}>
                Insights
              </h2>
              <button
                onClick={handleExportPNG}
                disabled={isExporting}
                style={{
                  padding: '8px 20px',
                  backgroundColor: isExporting ? '#4b5563' : '#8b5cf6',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: '600',
                  cursor: isExporting ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s',
                  height: '36px',
                  opacity: isExporting ? 0.6 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  boxShadow: isExporting ? 'none' : '0 2px 8px rgba(139, 92, 246, 0.3)'
                }}
                onMouseOver={(e) => {
                  if (!isExporting) {
                    e.target.style.backgroundColor = '#7c3aed'
                    e.target.style.boxShadow = '0 4px 12px rgba(139, 92, 246, 0.4)'
                  }
                }}
                onMouseOut={(e) => {
                  e.target.style.backgroundColor = isExporting ? '#4b5563' : '#8b5cf6'
                  e.target.style.boxShadow = isExporting ? 'none' : '0 2px 8px rgba(139, 92, 246, 0.3)'
                }}
              >
                {isExporting ? (
                  <>
                    <span style={{ 
                      display: 'inline-block', 
                      width: '12px', 
                      height: '12px', 
                      border: '2px solid rgba(255,255,255,0.3)', 
                      borderTopColor: 'white', 
                      borderRadius: '50%', 
                      animation: 'spin 0.6s linear infinite',
                      flexShrink: 0
                    }} />
                    Exporting...
                  </>
                ) : (
                  'Export PNG'
                )}
              </button>
            </div>

            {/* Big Concentration Card */}
            <div style={{
              padding: '32px',
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              borderRadius: '16px',
              border: '1px solid rgba(59, 130, 246, 0.2)',
              textAlign: 'center'
            }}>
              <div style={{
                fontSize: '64px',
                fontWeight: '800',
                color: '#60a5fa',
                lineHeight: '1',
                marginBottom: '8px'
              }}>
                {insights.concentrationPercent}%
              </div>
              <div style={{
                fontSize: '16px',
                color: '#9ca3af',
                fontWeight: '500'
              }}>
                of customers in top 3 zones
              </div>
            </div>

            {/* Two Column Layout */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
              gap: '24px'
            }}>
              {/* Top Dense Areas */}
              <div>
                <h3 style={{
                  margin: '0 0 16px 0',
                  fontSize: '18px',
                  fontWeight: '700',
                  color: '#ffffff',
                  borderBottom: '2px solid rgba(59, 130, 246, 0.3)',
                  paddingBottom: '8px'
                }}>
                  Top 3 Dense Areas
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {insights.topDenseAreas.map((area, idx) => {
                    const isActive = activeHighlight?.type === 'dense' && 
                      activeHighlight.center.lat === area.center.lat &&
                      activeHighlight.center.lng === area.center.lng
                    
                    return (
                    <div 
                      key={area.cellId} 
                      onClick={() => {
                        if (isActive) {
                          setActiveHighlight(null)
                        } else {
                          setActiveHighlight({
                            type: 'dense',
                            center: area.center,
                            radius: 1.0
                          })
                        }
                      }}
                      style={{
                        padding: '16px',
                        backgroundColor: isActive ? 'rgba(59, 130, 246, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                        borderRadius: '12px',
                        border: isActive ? '2px solid rgba(59, 130, 246, 0.6)' : '1px solid rgba(255, 255, 255, 0.1)',
                        transition: 'all 0.2s',
                        cursor: 'pointer'
                      }}
                      onMouseOver={(e) => {
                        if (!isActive) {
                          e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.08)'
                          e.target.style.borderColor = 'rgba(59, 130, 246, 0.4)'
                        }
                      }}
                      onMouseOut={(e) => {
                        if (!isActive) {
                          e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.05)'
                          e.target.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                        }
                      }}
                    >
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        marginBottom: '8px'
                      }}>
                        <div style={{
                          fontSize: '14px',
                          fontWeight: '600',
                          color: '#60a5fa'
                        }}>
                          #{idx + 1}
                        </div>
                        <div style={{
                          fontSize: '20px',
                          fontWeight: '700',
                          color: '#ffffff'
                        }}>
                          {area.count}
                        </div>
                      </div>
                      <div style={{
                        fontSize: '14px',
                        fontWeight: '600',
                        color: '#ffffff',
                        marginBottom: '4px'
                      }}>
                        {area.label || `${area.center.lat.toFixed(2)}, ${area.center.lng.toFixed(2)}`}
                      </div>
                      <div style={{
                        fontSize: '11px',
                        color: '#6b7280',
                        fontFamily: 'monospace'
                      }}>
                        {area.center.lat.toFixed(2)}, {area.center.lng.toFixed(2)}
                      </div>
                    </div>
                    )
                  })}
                </div>
              </div>

              {/* White Space Areas */}
              <div>
                <h3 style={{
                  margin: '0 0 16px 0',
                  fontSize: '18px',
                  fontWeight: '700',
                  color: '#ffffff',
                  borderBottom: '2px solid rgba(236, 72, 153, 0.3)',
                  paddingBottom: '8px'
                }}>
                  White Space Areas
                </h3>
                {insights.whiteSpaceAreas.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {insights.whiteSpaceAreas.map((area, idx) => {
                      const isActive = activeHighlight?.type === 'whitespace' && 
                        activeHighlight.center.lat === area.center.lat &&
                        activeHighlight.center.lng === area.center.lng
                      
                      // Calculate radius: use distanceKm rounded up, min 0.5km, max 3km
                      const radius = Math.min(3, Math.max(0.5, Math.ceil(area.distanceKm)))
                      
                      return (
                      <div 
                        key={area.cellId} 
                        onClick={() => {
                          if (isActive) {
                            setActiveHighlight(null)
                          } else {
                            setActiveHighlight({
                              type: 'whitespace',
                              center: area.center,
                              radius: radius
                            })
                          }
                        }}
                        style={{
                          padding: '16px',
                          backgroundColor: isActive ? 'rgba(236, 72, 153, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                          borderRadius: '12px',
                          border: isActive ? '2px solid rgba(236, 72, 153, 0.6)' : '1px solid rgba(255, 255, 255, 0.1)',
                          transition: 'all 0.2s',
                          cursor: 'pointer'
                        }}
                        onMouseOver={(e) => {
                          if (!isActive) {
                            e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.08)'
                            e.target.style.borderColor = 'rgba(236, 72, 153, 0.4)'
                          }
                        }}
                        onMouseOut={(e) => {
                          if (!isActive) {
                            e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.05)'
                            e.target.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                          }
                        }}
                      >
                        <div style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-start',
                          marginBottom: '8px'
                        }}>
                          <div style={{
                            fontSize: '14px',
                            fontWeight: '600',
                            color: '#ec4899'
                          }}>
                            #{idx + 1}
                          </div>
                          <div style={{
                            fontSize: '20px',
                            fontWeight: '700',
                            color: '#ffffff'
                          }}>
                            {area.count}
                          </div>
                        </div>
                        <div style={{
                          fontSize: '14px',
                          fontWeight: '600',
                          color: '#ffffff',
                          marginBottom: '4px'
                        }}>
                          {area.label || `${area.center.lat.toFixed(2)}, ${area.center.lng.toFixed(2)}`}
                        </div>
                        <div style={{
                          fontSize: '11px',
                          color: '#6b7280',
                          fontFamily: 'monospace',
                          marginBottom: '4px'
                        }}>
                          {area.center.lat.toFixed(2)}, {area.center.lng.toFixed(2)}
                        </div>
                        <div style={{
                          fontSize: '11px',
                          color: '#9ca3af',
                          fontStyle: 'italic'
                        }}>
                          {area.distanceKm} km from dense area
                        </div>
                      </div>
                      )
                    })}
                  </div>
                ) : (
                  <div style={{
                    padding: '24px',
                    textAlign: 'center',
                    color: '#6b7280',
                    fontSize: '14px',
                    fontStyle: 'italic',
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    borderRadius: '12px',
                    border: '1px solid rgba(255, 255, 255, 0.1)'
                  }}>
                    No white space areas found
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
