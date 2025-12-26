# API Server

Simple Express API for geocoding CSV uploads.

## Running Locally

### Prerequisites
- Node.js installed
- Docker and docker-compose installed
- Mapbox access token

### Quick Start

1. **Start the database:**
   ```bash
   docker compose -f ../../infra/docker-compose.yml up -d
   ```

2. **Apply database migrations:**
   ```bash
   docker exec -i postgres-dev psql -U postgres -d geocode < db/001_init.sql
   ```

3. **Set up environment:**
   ```bash
   # Create .env file in apps/api/
   echo "MAPBOX_TOKEN=your_mapbox_token_here" > .env
   ```

4. **Install dependencies and start:**
   ```bash
   npm install
   npm run dev
   ```

The API server will run on `http://localhost:3000`

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file in `apps/api/` with your Mapbox token:
```bash
MAPBOX_TOKEN=your_mapbox_token_here
CORS_ORIGIN=http://localhost:5173
```

**Important:** The server will fail to start if `MAPBOX_TOKEN` is not set.

**CORS_ORIGIN:** Optional. Defaults to `http://localhost:5173` for local development. Set to your deployed frontend URL (e.g., `https://your-app.onrender.com`) when deploying.

3. Ensure Postgres is running:
```bash
docker compose -f ../../infra/docker-compose.yml up -d
```

4. Apply database migrations (see `db/README.md`)

5. Start the server:
```bash
npm run dev
```

## Endpoints

### GET /health
Health check endpoint.

### POST /api/upload
Upload a CSV file for geocoding.

**Request:**
- Method: POST
- Content-Type: multipart/form-data
- Field name: `file`
- File type: CSV only

**Response:**
```json
{
  "uploadId": "uuid",
  "totalRows": 10,
  "validRows": 8,
  "invalidRows": 2
}
```

**Error Responses:**
- `400`: No file uploaded
- `400`: File must be a CSV
- `400`: Missing required columns
- `500`: Internal server error

### POST /api/uploads/:id/geocode
Start geocoding for an upload. Processes all pending rows in batches.

**Request:**
- Method: POST
- URL: `/api/uploads/{uploadId}/geocode`
- Body: None

**Response:**
```json
{
  "started": true
}
```

The endpoint returns immediately and processes geocoding asynchronously. The upload status is updated to `processing`, then to `done` (if at least one success) or `failed` (if all fail).

**Error Responses:**
- `404`: Upload not found

### GET /api/uploads/:id
Get upload status and statistics.

**Response:**
```json
{
  "id": "uuid",
  "status": "done",
  "total_rows": 10,
  "valid_rows": 8,
  "invalid_rows": 2
}
```

### GET /api/uploads/:id/points
Get all successfully geocoded points for an upload.

**Response:**
```json
[
  { "id": 1, "lat": 37.7749, "lng": -122.4194 },
  { "id": 2, "lat": 34.0522, "lng": -118.2437 }
]
```

## How to test upload

### Using curl

```bash
curl -X POST http://localhost:3000/api/upload \
  -F "file=@path/to/your/file.csv"
```

### Sample CSV formats

**Option 1: Single address column**
```csv
address,service_type,customer_count,revenue_bucket
123 Main St, San Francisco, CA 94102,restaurant,50,high
456 Oak Ave, Los Angeles, CA 90001,retail,25,medium
```

**Option 2: Separate street, city, postal columns**
```csv
street,city,postal,service_type,customer_count,revenue_bucket
123 Main St,San Francisco,94102,restaurant,50,high
456 Oak Ave,Los Angeles,90001,retail,25,medium
```

**Required columns:**
- Either `address` OR all of `street`, `city`, `postal`

**Optional columns:**
- `service_type`
- `customer_count`
- `revenue_bucket`

Rows with missing or empty addresses are counted as invalid and skipped.

## How to test geocoding

### 1. Upload a CSV file
```bash
curl -X POST http://localhost:3000/api/upload \
  -F "file=@path/to/your/file.csv"
```

Save the `uploadId` from the response.

### 2. Start geocoding
```bash
curl -X POST http://localhost:3000/api/uploads/{uploadId}/geocode
```

Replace `{uploadId}` with the UUID from step 1.

### 3. Check geocoded results

Connect to the database:
```bash
docker exec -it postgres-dev psql -U postgres -d geocode
```

Query geocoded rows:
```sql
-- Check upload status
SELECT id, status, total_rows, valid_rows, invalid_rows 
FROM uploads 
WHERE id = 'your-upload-id';

-- Check geocoding results
SELECT 
  row_index,
  raw_address,
  geocode_status,
  lat,
  lng,
  geocode_error,
  ST_AsText(geom::geometry) as geom_text
FROM upload_rows
WHERE upload_id = 'your-upload-id'
ORDER BY row_index;

-- Count by status
SELECT geocode_status, COUNT(*) 
FROM upload_rows 
WHERE upload_id = 'your-upload-id'
GROUP BY geocode_status;
```

### GET /api/uploads/:id/insights
Get insights for an upload: top dense areas, concentration percent, and white space areas.

**Response:**
```json
{
  "topDenseAreas": [
    {
      "cellId": "37.77,-122.42",
      "count": 12,
      "center": { "lat": 37.7749, "lng": -122.4194 }
    }
  ],
  "concentrationPercent": 67,
  "whiteSpaceAreas": [
    {
      "cellId": "37.76,-122.41",
      "count": 0,
      "center": { "lat": 37.7650, "lng": -122.4100 },
      "distanceKm": 1.2
    }
  ]
}
```

### Testing Insights - Sanity Check Query

To verify insights calculations match the data:

```sql
-- Replace 'your-upload-id' with actual upload ID

-- 1. Check total successful geocoded rows
SELECT COUNT(*) as total_success_rows
FROM upload_rows
WHERE upload_id = 'your-upload-id' 
  AND geocode_status = 'success' 
  AND lat IS NOT NULL 
  AND lng IS NOT NULL;

-- 2. Check total customers
SELECT COALESCE(SUM(customer_count), 0) as total_customers
FROM upload_rows
WHERE upload_id = 'your-upload-id' 
  AND geocode_status = 'success' 
  AND customer_count IS NOT NULL;

-- 3. Check top 3 dense cells (should match insights)
SELECT 
  ROUND(lat::numeric, 2) || ',' || ROUND(lng::numeric, 2) as cell_id,
  COUNT(*) as count,
  AVG(lat) as center_lat,
  AVG(lng) as center_lng,
  COALESCE(SUM(customer_count), 0) as total_customers
FROM upload_rows
WHERE upload_id = 'your-upload-id' 
  AND geocode_status = 'success' 
  AND lat IS NOT NULL 
  AND lng IS NOT NULL
GROUP BY ROUND(lat::numeric, 2), ROUND(lng::numeric, 2)
ORDER BY count DESC
LIMIT 3;

-- 4. Verify concentration calculation
WITH top3_cells AS (
  SELECT ROUND(lat::numeric, 2) as cell_lat, ROUND(lng::numeric, 2) as cell_lng
  FROM upload_rows
  WHERE upload_id = 'your-upload-id' 
    AND geocode_status = 'success' 
    AND lat IS NOT NULL 
    AND lng IS NOT NULL
  GROUP BY ROUND(lat::numeric, 2), ROUND(lng::numeric, 2)
  ORDER BY COUNT(*) DESC
  LIMIT 3
),
customers_in_top3 AS (
  SELECT COALESCE(SUM(customer_count), 0) as customers
  FROM upload_rows
  WHERE upload_id = 'your-upload-id' 
    AND geocode_status = 'success' 
    AND customer_count IS NOT NULL
    AND (ROUND(lat::numeric, 2), ROUND(lng::numeric, 2)) IN (
      SELECT cell_lat, cell_lng FROM top3_cells
    )
),
total_customers AS (
  SELECT COALESCE(SUM(customer_count), 0) as total
  FROM upload_rows
  WHERE upload_id = 'your-upload-id' 
    AND geocode_status = 'success' 
    AND customer_count IS NOT NULL
)
SELECT 
  cit.customers as customers_in_top3,
  tc.total as total_customers,
  CASE 
    WHEN tc.total > 0 THEN ROUND((cit.customers::numeric / tc.total::numeric) * 100)
    ELSE 0
  END as concentration_percent
FROM customers_in_top3 cit, total_customers tc;
```

