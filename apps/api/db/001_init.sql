-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- Create uploads table
CREATE TABLE uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    original_filename TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('uploaded', 'processing', 'done', 'failed')),
    total_rows INTEGER NOT NULL DEFAULT 0,
    valid_rows INTEGER NOT NULL DEFAULT 0,
    invalid_rows INTEGER NOT NULL DEFAULT 0
);

-- Create upload_rows table
CREATE TABLE upload_rows (
    id BIGSERIAL PRIMARY KEY,
    upload_id UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL,
    raw_address TEXT NOT NULL,
    normalized_address TEXT,
    service_type TEXT,
    customer_count INTEGER,
    revenue_bucket TEXT,
    geocode_status TEXT NOT NULL DEFAULT 'pending' CHECK (geocode_status IN ('pending', 'success', 'failed')),
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    geom GEOGRAPHY(POINT, 4326),
    geocode_error TEXT
);

-- Create indexes
CREATE INDEX idx_upload_rows_upload_id ON upload_rows(upload_id);
CREATE INDEX idx_upload_rows_geom ON upload_rows USING GIST(geom);

