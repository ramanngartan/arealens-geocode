# Database Migrations

## Local Development Setup

### Prerequisites
- Docker and docker-compose installed
- Postgres container running (from `infra/docker-compose.yml`)

### Applying Migrations

#### Option 1: Using docker exec (Recommended)

```bash
# From the repo root
docker exec -i postgres-dev psql -U postgres -d geocode < apps/api/db/001_init.sql
```

#### Option 2: Using psql directly

If you have psql installed locally and the database is accessible:

```bash
psql -h localhost -U postgres -d geocode -f apps/api/db/001_init.sql
```

### Verifying the Migration

Connect to the database and verify tables were created:

```bash
docker exec -it postgres-dev psql -U postgres -d geocode
```

Then run:
```sql
\dt
\d uploads
\d upload_rows
```

### Rolling Back

To drop all tables (if needed):

```sql
DROP TABLE IF EXISTS upload_rows CASCADE;
DROP TABLE IF EXISTS uploads CASCADE;
```

