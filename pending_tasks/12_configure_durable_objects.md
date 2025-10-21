# Task 12: Configure Durable Object Bindings

## Objective
Set up and configure Durable Object bindings for the Agent classes, establishing the infrastructure for stateful agent instances that persist across requests.

## Context
Durable Objects provide the stateful foundation for our Agent system. Each agent instance needs its own Durable Object to maintain conversation state, user context, and processing history. This task sets up the bindings and infrastructure needed for Task 11 (Agent Classes).

## Requirements

### 1. Create Durable Object Classes
Define Durable Object classes for different agent types:
- `TravelAgentDO` - Main travel planning agent
- `ScrapingAgentDO` - Web scraping coordination
- `ConversationManagerDO` - Cross-agent conversation state
- `SessionManagerDO` - User session management

### 2. Configure Wrangler Bindings
Update `wrangler.jsonc` with proper Durable Object configurations and namespace bindings.

### 3. Implement Durable Object Logic
Create the actual Durable Object implementations with state management, RPC methods, and lifecycle handling.

## Implementation Steps

### 1. Update Wrangler Configuration
Update `travel-agent-worker/wrangler.jsonc`:

```json
{
  "durable_objects": {
    "bindings": [
      {
        "name": "TRAVEL_AGENT",
        "class_name": "TravelAgentDO",
        "script_name": "travel-agent-worker"
      },
      {
        "name": "SCRAPING_AGENT",
        "class_name": "ScrapingAgentDO",
        "script_name": "travel-agent-worker"
      },
      {
        "name": "CONVERSATION_MANAGER",
        "class_name": "ConversationManagerDO",
        "script_name": "travel-agent-worker"
      },
      {
        "name": "SESSION_MANAGER",
        "class_name": "SessionManagerDO",
        "script_name": "travel-agent-worker"
      }
    ]
  }
}
```

### 2. Create Base Durable Object Class
Create `src/durable-objects/base-agent-do.ts`:

```typescript
export abstract class BaseAgentDO implements DurableObject {
  protected storage: DurableObjectStorage;
  protected env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.storage = state.storage;
    this.env = env;
  }

  // Abstract methods to be implemented by specific agent DOs
  abstract handleMessage(message: AgentMessage): Promise<AgentResponse>;
  abstract getState(): Promise<AgentState>;
  abstract updateState(updates: Partial<AgentState>): Promise<void>;

  // Common lifecycle methods
  async onStart(): Promise<void> {
    // Initialize agent state
    const existingState = await this.storage.get<AgentState>('state');
    if (!existingState) {
      await this.initializeState();
    }
  }

  async onStop(): Promise<void> {
    // Cleanup and persist final state
    await this.persistState();
  }

  // State management utilities
  protected async initializeState(): Promise<void> {
    const initialState: AgentState = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      lastUpdated: Date.now(),
      conversationHistory: [],
      extractedSlots: {},
      preferences: {},
      context: {}
    };

    await this.storage.put('state', initialState);
  }

  protected async persistState(): Promise<void> {
    const state = await this.storage.get<AgentState>('state');
    if (state) {
      state.lastUpdated = Date.now();
      await this.storage.put('state', state);
    }
  }

  // HTTP endpoint handler for external access
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    try {
      switch (url.pathname) {
        case '/message':
          if (method === 'POST') {
            const message = await request.json();
            const response = await this.handleMessage(message);
            return new Response(JSON.stringify(response), {
              headers: { 'Content-Type': 'application/json' }
            });
          }
          break;

        case '/state':
          if (method === 'GET') {
            const state = await this.getState();
            return new Response(JSON.stringify(state), {
              headers: { 'Content-Type': 'application/json' }
            });
          }
          break;

        case '/health':
          return new Response(JSON.stringify({ status: 'healthy' }), {
            headers: { 'Content-Type': 'application/json' }
          });

        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Method Not Allowed', { status: 405 });
  }
}
```

### 3. Implement Travel Agent Durable Object
Create `src/durable-objects/travel-agent-do.ts`:

```typescript
export class TravelAgentDO extends BaseAgentDO {
  private agentTools: AgentToolRegistry;
  private responseCache: Map<string, AgentResponse> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.agentTools = new AgentToolRegistry(env);
    this.initializeTools();
  }

  async handleMessage(message: AgentMessage): Promise<AgentResponse> {
    const { type, content, context } = message;

    // Update conversation history
    await this.addToConversationHistory(message);

    // Process the message based on type
    switch (type) {
      case 'chat':
        return await this.handleChatMessage(content, context);
      case 'tool_call':
        return await this.handleToolCall(content, context);
      case 'state_query':
        return await this.handleStateQuery(content, context);
      default:
        throw new Error(`Unsupported message type: ${type}`);
    }
  }

  async getState(): Promise<AgentState> {
    return await this.storage.get<AgentState>('state') || this.getDefaultState();
  }

  async updateState(updates: Partial<AgentState>): Promise<void> {
    const currentState = await this.getState();
    const newState = { ...currentState, ...updates, lastUpdated: Date.now() };
    await this.storage.put('state', newState);
  }

  private async handleChatMessage(content: string, context: AgentContext): Promise<AgentResponse> {
    // Extract intent from message
    const intent = await this.extractIntent(content, context);

    // Update slots with extracted information
    await this.updateExtractedSlots(intent.slots);

    // Determine required tools and execute
    const toolCalls = await this.planToolCalls(intent);
    const toolResults = await this.executeToolCalls(toolCalls);

    // Generate response based on tool results
    const response = await this.generateResponse(intent, toolResults);

    // Cache the response
    this.cacheResponse(content, response);

    return response;
  }

  private async extractIntent(content: string, context: AgentContext): Promise<TravelIntent> {
    // Use LLM to extract intent and slots from user message
    const prompt = this.buildIntentExtractionPrompt(content, context);
    const result = await this.env.AI.run('@cf/meta/llama-2-7b-chat-int8', {
      messages: [{ role: 'user', content: prompt }]
    });

    return this.parseIntentFromLLMResponse(result.response);
  }

  private async planToolCalls(intent: TravelIntent): Promise<ToolCall[]> {
    // Determine which tools to call based on intent
    const planningPrompt = this.buildPlanningPrompt(intent);
    const result = await this.env.AI.run('@cf/meta/llama-2-7b-chat-int8', {
      messages: [{ role: 'user', content: planningPrompt }]
    });

    return this.parseToolCallsFromLLMResponse(result.response);
  }

  private async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results = await Promise.allSettled(
      toolCalls.map(call => this.agentTools.executeTool(call.name, call.parameters))
    );

    return results.map((result, index) => ({
      toolCall: toolCalls[index],
      success: result.status === 'fulfilled',
      data: result.status === 'fulfilled' ? result.value : null,
      error: result.status === 'rejected' ? result.reason : null
    }));
  }

  private async generateResponse(intent: TravelIntent, toolResults: ToolResult[]): Promise<AgentResponse> {
    // Generate natural language response based on intent and tool results
    const responsePrompt = this.buildResponsePrompt(intent, toolResults);
    const result = await this.env.AI.run('@cf/meta/llama-2-7b-chat-int8', {
      messages: [{ role: 'user', content: responsePrompt }]
    });

    return {
      type: 'chat_response',
      content: result.response,
      confidence: this.calculateResponseConfidence(toolResults),
      sources: this.extractSources(toolResults),
      metadata: {
        intent,
        toolsUsed: toolResults.map(r => r.toolCall.name),
        timestamp: Date.now()
      }
    };
  }

  private initializeTools(): void {
    // Register available tools for this agent
    this.agentTools.registerTool('weather', new WeatherTool());
    this.agentTools.registerTool('flights', new AmadeusFlightTool());
    this.agentTools.registerTool('hotels', new AmadeusHotelTool());
    this.agentTools.registerTool('attractions', new AttractionsTool());
    this.agentTools.registerTool('search', new WebSearchTool());
  }
}
```

### 4. Implement Conversation Manager Durable Object
Create `src/durable-objects/conversation-manager-do.ts`:

```typescript
export class ConversationManagerDO extends BaseAgentDO {
  private activeAgents: Map<string, DurableObjectStub> = new Map();
  private conversationFlow: ConversationNode[] = [];

  async handleMessage(message: AgentMessage): Promise<AgentResponse> {
    const { type, content, context } = message;

    switch (type) {
      case 'start_conversation':
        return await this.startConversation(content, context);
      case 'route_message':
        return await this.routeMessage(content, context);
      case 'coordinate_agents':
        return await this.coordinateAgents(content, context);
      default:
        throw new Error(`Unsupported message type: ${type}`);
    }
  }

  private async startConversation(content: any, context: AgentContext): Promise<AgentResponse> {
    // Initialize conversation state
    const conversationId = crypto.randomUUID();
    const initialState = {
      id: conversationId,
      userId: context.userId,
      startedAt: Date.now(),
      participants: [],
      currentPhase: 'planning'
    };

    await this.storage.put(`conversation:${conversationId}`, initialState);

    // Determine which agents to activate
    const requiredAgents = await this.determineRequiredAgents(content);

    // Activate agent instances
    for (const agentType of requiredAgents) {
      const agentStub = await this.getAgentStub(agentType, conversationId);
      this.activeAgents.set(agentType, agentStub);
    }

    return {
      type: 'conversation_started',
      content: { conversationId, activeAgents: requiredAgents },
      metadata: { timestamp: Date.now() }
    };
  }

  private async routeMessage(content: any, context: AgentContext): Promise<AgentResponse> {
    const { message, targetAgent } = content;

    // Route message to specific agent or determine best agent
    const agent = targetAgent
      ? this.activeAgents.get(targetAgent)
      : await this.selectBestAgent(message, context);

    if (!agent) {
      throw new Error('No suitable agent found for message');
    }

    // Send message to agent and return response
    const response = await agent.fetch(new Request('https://agent/message', {
      method: 'POST',
      body: JSON.stringify({ type: 'chat', content: message, context })
    }));

    return await response.json();
  }

  private async getAgentStub(agentType: string, conversationId: string): Promise<DurableObjectStub> {
    const agentId = `${agentType}:${conversationId}`;

    switch (agentType) {
      case 'travel':
        return this.env.TRAVEL_AGENT.get(this.env.TRAVEL_AGENT.idFromName(agentId));
      case 'scraping':
        return this.env.SCRAPING_AGENT.get(this.env.SCRAPING_AGENT.idFromName(agentId));
      default:
        throw new Error(`Unknown agent type: ${agentType}`);
    }
  }
}
```

### 5. Create Agent Factory
Create `src/core/agent-factory.ts`:

```typescript
export class AgentFactory {
  constructor(private env: Env) {}

  async createTravelAgent(sessionId: string): Promise<DurableObjectStub> {
    const id = this.env.TRAVEL_AGENT.idFromName(`travel:${sessionId}`);
    return this.env.TRAVEL_AGENT.get(id);
  }

  async createConversationManager(conversationId: string): Promise<DurableObjectStub> {
    const id = this.env.CONVERSATION_MANAGER.idFromName(`conversation:${conversationId}`);
    return this.env.CONVERSATION_MANAGER.get(id);
  }

  async createScrapingAgent(taskId: string): Promise<DurableObjectStub> {
    const id = this.env.SCRAPING_AGENT.idFromName(`scraping:${taskId}`);
    return this.env.SCRAPING_AGENT.get(id);
  }

  async getOrCreateSessionManager(userId: string): Promise<DurableObjectStub> {
    const id = this.env.SESSION_MANAGER.idFromName(`session:${userId}`);
    return this.env.SESSION_MANAGER.get(id);
  }
}
```

### 6. Update Main Worker to Export Durable Objects
Update `src/index.ts`:

```typescript
// Export Durable Object classes
export { TravelAgentDO } from './durable-objects/travel-agent-do';
export { ScrapingAgentDO } from './durable-objects/scraping-agent-do';
export { ConversationManagerDO } from './durable-objects/conversation-manager-do';
export { SessionManagerDO } from './durable-objects/session-manager-do';

// Update fetch handler to use agents
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // ... existing code ...

    // Create agent factory
    const agentFactory = new AgentFactory(env);

    // Route chat requests to conversation manager
    if (url.pathname === '/chat') {
      const body = await request.json();
      const conversationManager = await agentFactory.createConversationManager(
        body.sessionId || 'default'
      );

      const response = await conversationManager.fetch(new Request('https://agent/message', {
        method: 'POST',
        body: JSON.stringify({
          type: 'route_message',
          content: { message: body.message },
          context: { userId: body.userId, sessionId: body.sessionId }
        })
      }));

      return response;
    }

    // ... rest of handler ...
  }
};
```

## Files to Create

### Durable Object Classes:
- `src/durable-objects/base-agent-do.ts` - Base DO class
- `src/durable-objects/travel-agent-do.ts` - Main travel agent
- `src/durable-objects/scraping-agent-do.ts` - Scraping coordinator
- `src/durable-objects/conversation-manager-do.ts` - Conversation orchestrator
- `src/durable-objects/session-manager-do.ts` - Session management

### Supporting Infrastructure:
- `src/core/agent-factory.ts` - Agent instance creation
- `src/types/durable-object-types.ts` - DO-specific types
- `src/utils/do-helpers.ts` - Durable Object utilities

### Modified Files:
- `src/index.ts` - Export DO classes and integrate
- `wrangler.jsonc` - Add DO bindings
- `src/core/chat-handler.ts` - Route to agents

## Configuration Tasks

### 1. Generate Types
After updating `wrangler.jsonc`:
```bash
cd travel-agent-worker
npm run cf-typegen
```

### 2. Test Durable Object Creation
```bash
# Deploy and test DO creation
npm run deploy
curl -X POST https://your-worker.workers.dev/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Plan a trip to Paris", "sessionId": "test123"}'
```

## Success Criteria
- [ ] Durable Object classes implemented and exported
- [ ] Wrangler configuration updated with bindings
- [ ] Agent factory for DO creation working
- [ ] State persistence across requests functioning
- [ ] Inter-agent communication working
- [ ] Main Worker integration complete
- [ ] HTTP endpoints for agent access working
- [ ] Type generation successful

## Testing Requirements
- Unit tests for each Durable Object class
- State persistence tests
- Agent communication tests
- Load testing with multiple concurrent sessions
- Failover and recovery testing
- Memory usage optimization tests

## Dependencies
- Agent class implementations (Task 11)
- Tool registry and migration
- LLM integration for agent decision-making
- D1 database for persistent storage
- Updated TypeScript types

## Performance Considerations
- Optimize Durable Object lifecycle management
- Implement efficient state serialization
- Minimize cold start times
- Use hibernation for inactive agents
- Implement proper cleanup and garbage collection
