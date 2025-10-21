# Travel Agent Backend - Cloudflare Workers

This is the Cloudflare Workers implementation of the AI Tr4. **Initialize database with migrations:**
   ```bash
   npm run db:migrate
   ```

   Or apply the initial schema directly:
   ```bash
   npm run db:execute -- --file=./migrations/001_initial_schema.sql
   ```

5. **Generate types:**
   ```bash
   npm run cf-typegen
   ```

## Database Management

### Migration Commands
```bash
# Apply all pending migrations
npm run db:migrate

# List applied migrations
npm run db:list

# Create a new migration
npm run db:create <migration-name>

# Execute a SQL file directly
npm run db:execute -- --file=<path-to-sql-file>

# Check migration status
npm run db:status
```

### Migration Helper Script
You can also use the migration helper script for more advanced operations:
```bash
# Apply migrations
./migrate.sh apply

# Create new migration
./migrate.sh create add_user_preferences

# Check status
./migrate.sh status

# See all commands
./migrate.sh help
```t Backend, migrated from the original Node.js/Express architecture to a serverless, edge-computing solution.

## Architecture

This implementation leverages Cloudflare's edge computing platform with the following components:

### Core Services
- **Cloudflare Workers**: Main API endpoints and request handling
- **Durable Objects**: Stateful agent instances for conversation management
- **D1 Database**: Relational data storage (sessions, messages, bookings)
- **R2 Object Storage**: File storage for scraped content and user uploads
- **KV Storage**: Fast caching and session data
- **Vectorize**: Vector database for semantic search and recommendations
- **Browser Rendering**: Web scraping with Playwright
- **Queues**: Asynchronous task processing
- **Workers AI**: Embedding generation and LLM operations

### Key Features
- **Serverless Architecture**: No servers to manage, automatic scaling
- **Edge Computing**: Low latency with global edge network
- **Stateful Conversations**: Durable Objects maintain agent state
- **Asynchronous Processing**: Background tasks via Queues
- **Vector Search**: Semantic search for travel recommendations
- **Web Scraping**: Automated data collection from travel sites

## Project Structure

```
travel-agent-worker/
├── src/
│   ├── index.ts              # Main Worker entry point
│   ├── router.ts             # HTTP routing logic
│   ├── core/
│   │   ├── chat-handler.ts   # Chat request processing
│   │   └── d1-repository.ts  # Database operations
│   ├── schemas/
│   │   └── chat.ts           # Request/response schemas
│   ├── types/
│   │   ├── env.ts            # Environment types
│   │   └── database.ts       # Database model types
│   └── utils/
│       ├── logger.ts         # Logging utilities
│       └── rate-limiter.ts   # Rate limiting logic
├── migrations/
│   └── 001_initial_schema.sql # Database schema
├── schema.sql                # Complete database schema
├── wrangler.jsonc           # Cloudflare Worker configuration
└── package.json             # Dependencies and scripts
```

## Setup

### Prerequisites
- Node.js 18+
- npm or yarn
- Cloudflare account
- Wrangler CLI installed globally

### Installation

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Install Wrangler CLI (if not already installed):**
   ```bash
   npm install -g wrangler
   ```

3. **Authenticate with Cloudflare:**
   ```bash
   wrangler login
   ```

### Configuration

1. **Update wrangler.jsonc:**
   - Replace placeholder database IDs with actual resource IDs
   - Update environment variables as needed

2. **Create Cloudflare resources:**
   ```bash
   # Create D1 database
   wrangler d1 create travel-agent-db

   # Create KV namespaces
   wrangler kv:namespace create "CACHE"
   wrangler kv:namespace create "SESSIONS"

   # Create R2 buckets
   wrangler r2 bucket create travel-agent-scraped-data
   wrangler r2 bucket create travel-agent-user-uploads

   # Create Vectorize index
   wrangler vectorize create travel-content-embeddings --dimensions=768 --metric=cosine

   # Create Queue
   wrangler queues create scraping-tasks
   ```

3. **Initialize database:**
   ```bash
   wrangler d1 execute travel-agent-db --file=./migrations/001_initial_schema.sql
   ```

4. **Generate types:**
   ```bash
   npm run cf-typegen
   ```

## Development

### Local Development
```bash
npm run dev
```

This starts the Worker in development mode with hot reloading.

### Testing
```bash
npm test
```

### Deployment
```bash
npm run deploy
```

## API Endpoints

### Main Endpoints
- `POST /chat` - Process chat messages with the AI agent
- `GET /healthz` - Health check endpoint
- `GET /metrics` - Performance metrics
- `GET /` - Basic information page

### Request Format
```json
{
  "message": "I want to plan a trip to Paris",
  "threadId": "optional-thread-id",
  "sessionId": "optional-session-id",
  "userId": "optional-user-id",
  "receipts": false
}
```

### Response Format
```json
{
  "reply": "I'd be happy to help you plan a trip to Paris!",
  "threadId": "generated-or-provided-thread-id",
  "sessionId": "session-identifier",
  "sources": [],
  "receipts": {}
}
```

## Database Schema

The D1 database includes tables for:
- **sessions**: User session management
- **messages**: Conversation history
- **slots**: Extracted travel parameters
- **thread_state**: Conversation state and intent
- **verifications**: Quality control results
- **travel_bookings**: Travel reservations
- **scraped_data**: Web scraping metadata
- **user_profiles**: User preferences
- **embeddings_metadata**: Vector search metadata
- **queue_logs**: Background task tracking
- **metrics**: Performance monitoring

## Migration Status

This implementation represents a migration from the original Node.js backend to Cloudflare Workers.

### Completed
- ✅ Basic Worker setup and configuration
- ✅ HTTP routing and CORS handling
- ✅ D1 database schema design
- ✅ TypeScript types and interfaces
- ✅ Rate limiting with KV
- ✅ Basic chat endpoint structure

### In Progress
- 🔄 R2 bucket creation and management
- 🔄 KV namespace setup
- 🔄 Redis migration to Cloudflare storage
- 🔄 Agent logic with Durable Objects
- 🔄 Web scraping with Browser Rendering
- 🔄 Queue-based async processing
- 🔄 Vectorize integration for semantic search

### Planned
- 📋 Complete chat logic migration
- 📋 Durable Object agent classes
- 📋 Browser Rendering scraper
- 📋 Vectorize + Workers AI integration
- 📋 Comprehensive testing
- 📋 Performance optimization

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass
6. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For questions or issues, please open an issue in the GitHub repository.
