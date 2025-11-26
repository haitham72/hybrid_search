//  supabase edge function
import { createClient } from 'npm:@supabase/supabase-js@2'
import OpenAI from 'npm:openai'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const openaiApiKey = Deno.env.get('OPENAI_API_KEY')!

// Function to analyze query and determine optimal weights
function analyzeQueryAndGetWeights(query: string) {
  const cleanQuery = query.trim()
  const wordCount = cleanQuery.split(/\s+/).length
  const charCount = cleanQuery.length
  
  const isLikelyName = wordCount <= 3 && charCount <= 30
  const isLongSemanticQuery = wordCount > 5 || charCount > 50
  
  let weights = {
    dense_weight: 0.40,
    sparse_weight: 0.15,
    pattern_weight: 0.20,
    trigram_weight: 0.25
  }
  
  if (isLikelyName) {
    weights = {
      dense_weight: 0.20,
      sparse_weight: 0.25,
      pattern_weight: 0.30,
      trigram_weight: 0.25
    }
  } else if (isLongSemanticQuery) {
    weights = {
      dense_weight: 0.55,
      sparse_weight: 0.20,
      pattern_weight: 0.15,
      trigram_weight: 0.10
    }
  } else if (wordCount >= 4 && wordCount <= 5) {
    weights = {
      dense_weight: 0.40,
      sparse_weight: 0.25,
      pattern_weight: 0.20,
      trigram_weight: 0.15
    }
  }
  
  return {
    weights,
    analysis: {
      wordCount,
      charCount,
      isLikelyName,
      isLongSemanticQuery,
      queryType: isLikelyName ? 'name' : isLongSemanticQuery ? 'semantic' : 'mixed'
    }
  }
}

Deno.serve(async (req) => {
  console.log('============ FUNCTION CALLED ============')
  console.log('Method:', req.method)
  console.log('URL:', req.url)
  
  try {
    const body = await req.json()
    console.log('Raw request body:', JSON.stringify(body, null, 2))
    
    let extractedQuery = null
    let extractedParams: any = {}
    
    // STRATEGY 1: Try to parse parameters0_Value (n8n format)
    if (body.parameters0_Value) {
      console.log('━━━ Found parameters0_Value field ━━━')
      console.log('Type:', typeof body.parameters0_Value)
      console.log('Raw value:', body.parameters0_Value)
      console.log('Value length:', body.parameters0_Value.length)
      
      let stringToParse = body.parameters0_Value
      
      // If it's already an object, use it directly
      if (typeof stringToParse === 'object') {
        console.log('✅ parameters0_Value is already an object')
        extractedQuery = stringToParse.query
        extractedParams = stringToParse
      } else {
        // It's a string, parse it
        try {
          // Remove any leading/trailing whitespace and newlines
          stringToParse = stringToParse.trim().replace(/^\n+|\n+$/g, '')
          console.log('Cleaned string:', stringToParse)
          console.log('First 50 chars:', stringToParse.substring(0, 50))
          
          const parsed = JSON.parse(stringToParse)
          console.log('✅ Successfully parsed parameters0_Value')
          console.log('Parsed object:', JSON.stringify(parsed, null, 2))
          
          if (parsed.query) {
            extractedQuery = parsed.query
            extractedParams = parsed
            console.log('✅ Extracted query:', extractedQuery)
            console.log('✅ Extracted weights:', {
              dense: parsed.dense_weight,
              sparse: parsed.sparse_weight,
              pattern: parsed.pattern_weight
            })
          } else {
            console.log('⚠️  Parsed object has no query field')
          }
        } catch (parseError) {
          console.error('❌ Failed to parse parameters0_Value')
          console.error('Error:', parseError.message)
          console.error('String was:', stringToParse)
          console.error('Char codes:', [...stringToParse.substring(0, 20)].map(c => c.charCodeAt(0)))
        }
      }
    }
    
    // STRATEGY 2: Check if query field itself contains JSON string
    const rawQuery = body.query || body.chatInput
    if (!extractedQuery && rawQuery && typeof rawQuery === 'string' && rawQuery.trim().startsWith('{')) {
      console.log('━━━ Query field looks like JSON, attempting parse ━━━')
      try {
        const parsed = JSON.parse(rawQuery.trim())
        if (parsed.query) {
          extractedQuery = parsed.query
          extractedParams = parsed
          console.log('✅ Extracted from query field:', extractedQuery)
        }
      } catch (e) {
        console.log('❌ Not valid JSON, using as-is')
      }
    }
    
    // STRATEGY 3: Use raw query as-is
    if (!extractedQuery) {
      extractedQuery = rawQuery
      console.log('Using raw query:', extractedQuery)
    }
    
    if (!extractedQuery) {
      return new Response(
        JSON.stringify({ error: 'Query is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Clean and normalize the final query
    const cleanQuery = extractedQuery.trim().replace(/\s+/g, ' ')
    
    // CRITICAL FIX: Extract primary term for pattern/keyword matching
    // Pattern matching uses ILIKE '%query%' which needs SHORT terms
    // Use first word/term for pattern matching, full query for semantic
    const words = cleanQuery.split(/\s+/)
    const primaryTerm = words[0] // First word is usually the main search term
    
    console.log('━━━ Query Processing ━━━')
    console.log('Full query (for semantic):', cleanQuery)
    console.log('Primary term (for pattern/keyword):', primaryTerm)
    console.log('Word count:', words.length)
    
    // Use primary term for the database search
    // This ensures pattern_search can find substring matches
    const searchQuery = words.length > 3 ? primaryTerm : cleanQuery
    
    console.log('━━━ Final query for database:', searchQuery)
    
    // Get weights from extracted params or analyze query
    const { weights: autoWeights, analysis } = analyzeQueryAndGetWeights(cleanQuery)
    
    let dense_weight = extractedParams.dense_weight ?? body.dense_weight ?? autoWeights.dense_weight
    let sparse_weight = extractedParams.sparse_weight ?? body.sparse_weight ?? autoWeights.sparse_weight
    let pattern_weight = extractedParams.pattern_weight ?? body.pattern_weight ?? autoWeights.pattern_weight
    let trigram_weight = extractedParams.trigram_weight ?? body.trigram_weight ?? autoWeights.trigram_weight
    const match_count = extractedParams.match_count ?? body.match_count ?? 10
    
    // CRITICAL: Normalize weights to sum to 1.0
    const weightSum = dense_weight + sparse_weight + pattern_weight + trigram_weight
    if (Math.abs(weightSum - 1.0) > 0.0001) {
      console.log(`⚠️  Normalizing weights (sum was ${weightSum})`)
      dense_weight = dense_weight / weightSum
      sparse_weight = sparse_weight / weightSum
      pattern_weight = pattern_weight / weightSum
      trigram_weight = trigram_weight / weightSum
    }
    
    console.log('━━━ FINAL PARAMETERS ━━━')
    console.log('Query:', cleanQuery)
    console.log('Weights:', { dense_weight, sparse_weight, pattern_weight, trigram_weight })
    console.log('Sum:', dense_weight + sparse_weight + pattern_weight + trigram_weight)
    console.log('Match count:', match_count)
    
    // Generate embedding
    console.log('Generating embedding...')
    const openai = new OpenAI({ apiKey: openaiApiKey })
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: cleanQuery,  // Use FULL query for semantic embedding
      dimensions: 1536,
    })
    const [{ embedding }] = embeddingResponse.data
    console.log(`✅ Embedding generated (length: ${embedding.length})`)

    // Call Supabase
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)
    
    const rpcParams = {
      query_text: searchQuery,  // Use PRIMARY TERM for pattern/keyword matching
      query_embedding: embedding,  // Full query embedding for semantic search
      match_count: match_count,
      dense_weight: dense_weight,
      sparse_weight: sparse_weight,
      pattern_weight: pattern_weight,
      trigram_weight: trigram_weight
    }
    
    console.log('Calling hybrid_search RPC...')
    const { data: documents, error } = await supabase.rpc('hybrid_search', rpcParams)

    if (error) {
      console.error('❌ RPC error:', error)
      throw error
    }

    console.log('━━━ RESULTS ━━━')
    console.log('Documents returned:', documents?.length)
    
    if (documents && documents.length > 0) {
      console.log('Top 3 results:')
      documents.slice(0, 3).forEach((doc, idx) => {
        console.log(`  ${idx + 1}. [ID:${doc.id}] ${doc.metadata?.poem_name}`)
        console.log(`     Vector: ${doc.vector_score?.toFixed(4)} | Keyword: ${doc.keyword_score} | Pattern: ${doc.pattern_score} | Trigram: ${doc.trigram_score?.toFixed(4)}`)
        console.log(`     Final: ${doc.final_score?.toFixed(6)}`)
      })
    }

    return new Response(JSON.stringify({ 
      documents,
      query_info: {
        original_input: body,
        processed_query: cleanQuery,
        weights_used: {
          dense_weight,
          sparse_weight,
          pattern_weight,
          trigram_weight
        }
      }
    }), {
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
      },
    })
    
  } catch (error) {
    console.error('❌ FATAL ERROR:', error)
    return new Response(
      JSON.stringify({ 
        error: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
        stack: error.stack
      }),
      { 
        status: 500, 
        headers: { 'Content-Type': 'application/json' } 
      }
    )
  }
})