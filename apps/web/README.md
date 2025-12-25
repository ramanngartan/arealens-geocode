# Web App

React + Vite frontend for geocoding CSV uploads with Mapbox visualization.

## Running Locally

### Prerequisites
- Node.js installed
- Mapbox access token (public token for client-side use)

### Quick Start

1. **Set up environment:**
   ```bash
   # Create .env file in apps/web/
   echo "VITE_MAPBOX_TOKEN=your_mapbox_token_here" > .env
   ```
   Note: Use a public Mapbox token (starts with `pk.`) for client-side use.

2. **Install dependencies and start:**
   ```bash
   npm install
   npm run dev
   ```

The web app will run on `http://localhost:5173` (or another port if 5173 is busy)

## Running Both Servers

To run the full application:

1. **Terminal 1 - Start database:**
   ```bash
   docker compose -f ../../infra/docker-compose.yml up -d
   ```

2. **Terminal 2 - Start API server:**
   ```bash
   cd apps/api
   npm install
   # Create .env with MAPBOX_TOKEN
   npm run dev
   ```

3. **Terminal 3 - Start web app:**
   ```bash
   cd apps/web
   npm install
   # Create .env with VITE_MAPBOX_TOKEN
   npm run dev
   ```

4. **Open browser:**
   Navigate to `http://localhost:5173` (or the port shown in the terminal)

## Usage

1. Select a CSV file using the file picker
2. Click "Upload" to upload the file
3. Once uploaded, click "Run Geocode" to start geocoding
4. The status will show "Processing..." while geocoding
5. When complete, geocoded points will appear on the map as blue circles

## CSV Format

The CSV file should have either:
- A single `address` column, OR
- Three columns: `street`, `city`, `postal`

Optional columns: `service_type`, `customer_count`, `revenue_bucket`
