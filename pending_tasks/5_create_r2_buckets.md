# Task 5: Create R2 Buckets and Storage Layer

## Status: ✅ BUCKETS CREATED - 🔄 IMPLEMENTATION NEEDED

## Objective
Create and configure R2 buckets for unstructured data storage (scraped content, user uploads) and implement the R2 storage client integration.

## Context
✅ **COMPLETED**: R2 buckets have been created and configured in wrangler.jsonc
🔄 **REMAINING**: Need to implement R2 storage service and integration

The travel agent currently stores unstructured data locally or in memory. We need to migrate this to Cloudflare R2 for scalable object storage. R2 buckets will store:
- Scraped web pages and travel data
- User-uploaded documents and images
- Generated reports and PDFs
- Cached API responses that are too large for KV

## ✅ Completed: R2 Buckets Created
The following buckets have been successfully created and configured:
- `travel-agent-scraped-data` - For web scraping results
- `travel-agent-user-uploads` - For user-uploaded files  
- `travel-agent-cache` - For large cached responses

Current wrangler.jsonc configuration:
```jsonc
"r2_buckets": [
  {
    "binding": "SCRAPED_DATA",
    "bucket_name": "travel-agent-scraped-data"
  },
  {
    "binding": "USER_UPLOADS",
    "bucket_name": "travel-agent-user-uploads"
  },
  {
    "binding": "CACHE_BUCKET",
    "bucket_name": "travel-agent-cache"
  }
]
```

### 3. Implement R2 Storage Service
Create `travel-agent-worker/src/core/r2-storage.ts` with:
- Upload functionality for different file types
- Download and retrieval methods
- File metadata handling
- Error handling and retry logic
- File size and type validation

### 4. Integration Points
Update the following components to use R2:
- Scraped data storage in `d1-repository.ts`
- File upload handling in main Worker
- Cache storage for large responses

## Implementation Steps

1. **Create buckets via Wrangler:**
   ```bash
   cd travel-agent-worker
   wrangler r2 bucket create travel-agent-scraped-data
   wrangler r2 bucket create travel-agent-user-uploads
   wrangler r2 bucket create travel-agent-cache
   ```

2. **Create R2 storage service:**
   - File upload/download methods
   - Metadata handling
   - URL generation for file access
   - Integration with D1 for file metadata

3. **Update existing code:**
   - Modify scraped data storage to use R2
   - Add file upload endpoints
   - Update D1 repository to reference R2 keys

4. **Add TypeScript types:**
   - R2 operation interfaces
   - File metadata types
   - Upload/download response types

## Files to Create/Modify

### New Files:
- `src/core/r2-storage.ts` - R2 storage service
- `src/types/r2.ts` - R2-related types
- `src/utils/file-validation.ts` - File validation utilities

### Modified Files:
- `src/core/d1-repository.ts` - Add R2 key references
- `src/index.ts` - Add file upload endpoints
- `wrangler.jsonc` - Update with actual bucket names

## Success Criteria
- [ ] All R2 buckets created and accessible
- [ ] R2 storage service implemented with upload/download
- [ ] D1 database integrated with R2 file references
- [ ] File upload endpoints working
- [ ] Error handling and validation in place
- [ ] Type safety for all R2 operations

## Testing Requirements
- Unit tests for R2 storage service
- Integration tests for file upload/download
- Error scenario testing (bucket unavailable, file too large)
- Performance testing for large file uploads

## Dependencies
- Existing D1 database schema (already implemented)
- Wrangler configuration (already configured)
- TypeScript types for Env (already implemented)
