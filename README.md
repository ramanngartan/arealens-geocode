# AreaLens

AreaLens is a spatial analytics tool that helps local service businesses understand their customer distribution by converting CSV address data into interactive maps and actionable insights.

## Live Demo

**App:** https://arealens-geocode-1.onrender.com/

**API health:** https://arealens-geocode.onrender.com/health

## Demo Flow (2 minutes)

1. Open the app
2. Upload `test.csv` (located in `arealens/` folder)
3. Click Run Geocode
4. Toggle Heatmap
5. Open Insights and click an area to highlight
6. Export PNG

## What This MVP Intentionally Does NOT Do

This MVP is intentionally limited in scope. It does not include:

- User authentication or authorization
- Billing or payment processing
- CRM integrations
- Real-time data updates
- Mobile applications
- AI-powered features

## Core Workflow

1. **Upload CSV**: Select and upload a CSV file containing customer addresses
2. **Geocode addresses**: The system processes addresses and geocodes them using Mapbox
3. **View map**: Visualize geocoded locations as points or heatmap overlay on an interactive Mapbox map
4. **View insights**: Access analytics including top dense areas, customer concentration percentage, and white space opportunities
5. **Export PNG**: Export the current map and insights view as a PNG image

## Tech Stack

**Frontend**
- React 19
- Vite
- Mapbox GL JS

**Backend**
- Node.js
- Express
- PostgreSQL with PostGIS

**Database**
- PostgreSQL 16
- PostGIS 3.4

**Mapping / Geocoding**
- Mapbox Geocoding API
- Mapbox GL JS for map rendering

## Local Development

### Prerequisites
- Node.js
- Docker and docker-compose
- Mapbox access tokens (public token for frontend, secret token for backend)

### Setup Steps

1. **Start PostgreSQL database:**
   ```bash
   docker compose -f arealens/infra/docker-compose.yml up -d
   ```

2. **Apply database migrations:**
   ```bash
   docker exec -i postgres-dev psql -U postgres -d geocode < arealens/apps/api/db/001_init.sql
   ```

3. **Start API server:**
   ```bash
   cd arealens/apps/api
   npm install
   # Create .env file with: MAPBOX_TOKEN=your_secret_token, DATABASE_URL=postgresql://postgres:postgres@localhost:5432/geocode
   npm run dev
   ```
   API runs on `http://localhost:3000`

4. **Start web application:**
   ```bash
   cd arealens/apps/web
   npm install
   # Create .env file with: VITE_MAPBOX_TOKEN=your_public_token
   npm run dev
   ```
   Web app runs on `http://localhost:5173`

5. **Open browser:**
   Navigate to `http://localhost:5173`

## CSV Format

### Required Columns

The CSV must include either:
- A single `address` column with complete addresses, OR
- Three columns: `street`, `city`, and `postal` (all three required)

### Optional Columns

- `service_type`: Type of service provided
- `customer_count`: Number of customers
- `revenue_bucket`: Revenue categorization

### Example CSV

```csv
address,service_type,customer_count,revenue_bucket
123 Main St, San Francisco, CA 94102,restaurant,50,high
456 Oak Ave, Los Angeles, CA 90001,retail,25,medium
```

Or using separate columns:

```csv
street,city,postal,service_type,customer_count,revenue_bucket
123 Main St,San Francisco,94102,restaurant,50,high
456 Oak Ave,Los Angeles,90001,retail,25,medium
```

## Troubleshooting

- **Frontend loads but upload fails (500):** API cannot reach DB (check Render API logs, DATABASE_URL pooler :6543, schema exists).
- **CORS error in browser:** CORS_ORIGIN on API must exactly match the frontend URL.
- **Map is blank:** missing/invalid VITE_MAPBOX_TOKEN (frontend env var).
- **Geocoding doesn't run:** missing/invalid MAPBOX_TOKEN on API.
- **Cold start:** Render free web service may sleep; first request can be slow.

## Project Status

**Finished MVP / Side Project**

This project was built as a learning exercise and MVP demonstration. The success criteria was to create a functional tool that allows users to upload CSV data, geocode addresses, visualize spatial patterns, and extract meaningful insights about customer distribution. The MVP successfully demonstrates the core workflow from data upload through visualization to insight generation.

