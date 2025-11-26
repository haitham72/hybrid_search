## Doc table

DROP TABLE IF EXISTS documents CASCADE;
DROP FUNCTION IF EXISTS hybrid_search(text, vector, integer, double precision, double precision, double precision, integer);

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  content text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  
  -- Triple config: simple + arabic + english for maximum coverage
  fts tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(metadata->>'poem_name', '')), 'A') ||
    setweight(to_tsvector('arabic', coalesce(metadata->>'poem_name', '')), 'A') ||
    setweight(to_tsvector('english', coalesce(metadata->>'poem_name', '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'B') ||
    setweight(to_tsvector('arabic', coalesce(content, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(metadata->>'summary', '')), 'C') ||
    setweight(to_tsvector('arabic', coalesce(metadata->>'summary', '')), 'C') ||
    setweight(to_tsvector('english', coalesce(metadata->>'summary', '')), 'C')
  ) STORED,
  
  embedding vector(1536)
);

CREATE INDEX documents_fts_idx ON documents USING gin(fts);
CREATE INDEX documents_embedding_idx ON documents USING hnsw (embedding vector_ip_ops);
CREATE INDEX documents_metadata_idx ON documents USING gin(metadata);
CREATE INDEX documents_content_trgm_idx ON documents USING gin(content gin_trgm_ops);
CREATE INDEX documents_metadata_poem_name_trgm_idx ON documents USING gin((metadata->>'poem_name') gin_trgm_ops);
