--hybrid search

DROP FUNCTION IF EXISTS hybrid_search(text, vector, integer, double precision, double precision, double precision, double precision, integer);

CREATE OR REPLACE FUNCTION hybrid_search(
  query_text text,
  query_embedding vector(1536),
  match_count int DEFAULT 10,
  dense_weight float DEFAULT 0.40,
  sparse_weight float DEFAULT 0.15,
  pattern_weight float DEFAULT 0.20,
  trigram_weight float DEFAULT 0.25,
  rrf_k int DEFAULT 50
)
RETURNS TABLE (
  id bigint,
  content text,
  metadata jsonb,
  vector_score float,
  keyword_score float,
  pattern_score float,
  trigram_score float,
  vector_rank bigint,
  keyword_rank bigint,
  pattern_rank bigint,
  trigram_rank bigint,
  final_score float
)
LANGUAGE plpgsql
AS $$
DECLARE
  query_tsquery tsquery;
BEGIN
  IF ABS((dense_weight + sparse_weight + pattern_weight + trigram_weight) - 1.0) > 0.001 THEN
    RAISE EXCEPTION 'Weights must sum to 1.0. Current: dense=%, sparse=%, pattern=%, trigram=%',
      dense_weight, sparse_weight, pattern_weight, trigram_weight;
  END IF;

  BEGIN
    query_tsquery := 
      COALESCE(websearch_to_tsquery('simple', query_text), to_tsquery('simple', '')) ||
      COALESCE(websearch_to_tsquery('arabic', query_text), to_tsquery('simple', '')) ||
      COALESCE(websearch_to_tsquery('english', query_text), to_tsquery('simple', ''));
  EXCEPTION WHEN OTHERS THEN
    query_tsquery := 
      plainto_tsquery('simple', query_text) ||
      plainto_tsquery('arabic', query_text) ||
      plainto_tsquery('english', query_text);
  END;

  RETURN QUERY
  WITH   semantic_search AS (
    SELECT
      d.id,
      (1 - (d.embedding <=> query_embedding))::float AS vector_score,
      row_number() OVER (ORDER BY d.embedding <=> query_embedding) AS rank_ix
    FROM documents d
    ORDER BY d.embedding <=> query_embedding
    LIMIT GREATEST(match_count * 5, 50)
  ),
  keyword_search AS (
    SELECT
      d.id,
      ts_rank_cd(d.fts, query_tsquery)::float AS keyword_score,
      row_number() OVER(ORDER BY ts_rank_cd(d.fts, query_tsquery) DESC) AS rank_ix
    FROM documents d
    WHERE d.fts @@ query_tsquery
    ORDER BY keyword_score DESC
    LIMIT GREATEST(match_count * 10, 100)
  ),
  pattern_search AS (
    SELECT
      d.id,
      CASE 
        WHEN (d.metadata->>'people') ILIKE '%' || query_text || '%' THEN 4.0
        WHEN (d.metadata->>'poem_name') ILIKE '%' || query_text || '%' THEN 3.0
        WHEN d.content ILIKE '%' || query_text || '%' THEN 1.0
        ELSE 0.0
      END::float AS pattern_score,
      row_number() OVER (
        ORDER BY 
          CASE 
            WHEN (d.metadata->>'people') ILIKE '%' || query_text || '%' THEN 4
            WHEN (d.metadata->>'poem_name') ILIKE '%' || query_text || '%' THEN 3
            WHEN d.content ILIKE '%' || query_text || '%' THEN 1
            ELSE 0
          END DESC
      ) AS rank_ix
    FROM documents d
    WHERE (d.metadata->>'people') ILIKE '%' || query_text || '%'
       OR (d.metadata->>'poem_name') ILIKE '%' || query_text || '%' 
       OR d.content ILIKE '%' || query_text || '%'
    LIMIT GREATEST(match_count * 10, 100)
  ),
  trigram_search AS (
    SELECT DISTINCT ON (d.id)
      d.id,
      GREATEST(
        word_similarity(query_text, d.content) * 3.0,
        word_similarity(query_text, d.metadata->>'poem_name') * 4.0,
        word_similarity(query_text, d.metadata->>'people') * 5.0,
        similarity(d.content, query_text) * 1.0,
        similarity(d.metadata->>'poem_name', query_text) * 2.0,
        similarity(d.metadata->>'people', query_text) * 3.0,
        CASE 
          WHEN d.content LIKE '%' || query_text || '%' THEN 1.5
          WHEN d.metadata->>'poem_name' LIKE '%' || query_text || '%' THEN 2.5
          WHEN d.metadata->>'people' LIKE '%' || query_text || '%' THEN 3.5
          ELSE 0
        END
      )::float AS trigram_score,
      row_number() OVER (
        ORDER BY 
          GREATEST(
            word_similarity(query_text, d.content),
            word_similarity(query_text, d.metadata->>'poem_name'),
            word_similarity(query_text, d.metadata->>'people')
          ) DESC
      ) AS rank_ix
    FROM documents d
    WHERE 
      d.content LIKE '%' || query_text || '%'
      OR d.metadata->>'poem_name' LIKE '%' || query_text || '%'
      OR d.metadata->>'people' LIKE '%' || query_text || '%'
      OR word_similarity(query_text, d.content) > 0.05
      OR word_similarity(query_text, d.metadata->>'poem_name') > 0.05
      OR word_similarity(query_text, d.metadata->>'people') > 0.05
    LIMIT GREATEST(match_count * 10, 100)
  )
  SELECT
    d.id,
    d.content,
    d.metadata,
    COALESCE(s.vector_score, 0.0)::float AS vector_score,
    COALESCE(k.keyword_score, 0.0)::float AS keyword_score,
    COALESCE(p.pattern_score, 0.0)::float AS pattern_score,
    COALESCE(t.trigram_score, 0.0)::float AS trigram_score,
    s.rank_ix AS vector_rank,
    k.rank_ix AS keyword_rank,
    p.rank_ix AS pattern_rank,
    t.rank_ix AS trigram_rank,
    (
      (dense_weight * COALESCE(1.0 / (rrf_k + s.rank_ix), 0.0)) +
      (sparse_weight * COALESCE(1.0 / (rrf_k + k.rank_ix), 0.0)) +
      (pattern_weight * COALESCE(1.0 / (rrf_k + p.rank_ix), 0.0)) +
      (trigram_weight * COALESCE(1.0 / (rrf_k + t.rank_ix), 0.0))
    )::float AS final_score
  FROM semantic_search s
  FULL OUTER JOIN keyword_search k ON s.id = k.id
  FULL OUTER JOIN pattern_search p ON COALESCE(s.id, k.id) = p.id
  FULL OUTER JOIN trigram_search t ON COALESCE(s.id, k.id, p.id) = t.id
  JOIN documents d ON d.id = COALESCE(s.id, k.id, p.id, t.id)
  ORDER BY final_score DESC
  LIMIT least(match_count, 30);
END;
$$;