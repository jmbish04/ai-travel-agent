# Task 11: Refactor Agent Logic into Agent Classes

## Objective
Migrate the existing meta-agent logic to Cloudflare's Agents SDK, refactoring the monolithic agent system into modular, stateful Agent classes that run on Durable Objects.

## Context
The current system has a complex meta-agent in `root/src/agent/meta_agent.ts` that handles all travel planning logic. We need to break this down into specialized Agent classes using Cloudflare's Agents SDK, which provides state persistence and scalable agent instances.

## Current Agent Analysis

### Existing Files to Analyze:
- `root/src/agent/meta_agent.ts` - Main agent logic
- `root/src/core/blend.ts` - Response blending logic
- `root/src/agent/tools/` - Tool implementations
- `root/src/core/slot_memory.ts` - State management
- `root/src/core/context_manager.ts` - Context handling

### Current Agent Capabilities:
1. **Planning and Routing**: Determines which tools to use
2. **Tool Execution**: Calls various travel APIs and services
3. **Response Blending**: Combines multiple data sources
4. **State Management**: Maintains conversation context
5. **Verification**: Self-checks response quality

## Migration Strategy

### 1. Agent Class Architecture
Design specialized agent classes for different travel domains:

```typescript
// Base agent class extending Agents SDK
abstract class TravelAgent extends Agent {
  abstract async handleIntent(intent: TravelIntent): Promise<AgentResponse>;
  abstract async validateResponse(response: AgentResponse): Promise<ValidationResult>;

  protected async persistState(state: AgentState): Promise<void> {
    // Use Durable Object storage
    await this.storage.put('state', state);
  }

  protected async getState(): Promise<AgentState | null> {
    return await this.storage.get('state');
  }
}
```

### 2. Specialized Agent Classes

#### Weather Agent (`src/agents/weather-agent.ts`)
```typescript
export class WeatherAgent extends TravelAgent {
  async handleIntent(intent: WeatherIntent): Promise<WeatherResponse> {
    const { destination, dates } = intent;

    // Get weather data
    const weatherData = await this.getWeatherTool().forecast(destination, dates);

    // Analyze travel implications
    const analysis = await this.analyzeWeatherForTravel(weatherData);

    // Generate recommendations
    const recommendations = await this.generateWeatherRecommendations(analysis);

    return {
      weather: weatherData,
      analysis,
      recommendations,
      confidence: this.calculateConfidence(weatherData)
    };
  }

  private async analyzeWeatherForTravel(weather: WeatherData): Promise<WeatherAnalysis> {
    // Analyze weather patterns for travel planning
    return {
      suitability: this.assessTravelSuitability(weather),
      packingRecommendations: this.generatePackingAdvice(weather),
      activityRecommendations: this.suggestActivities(weather)
    };
  }
}
```

#### Destination Agent (`src/agents/destination-agent.ts`)
```typescript
export class DestinationAgent extends TravelAgent {
  async handleIntent(intent: DestinationIntent): Promise<DestinationResponse> {
    const { query, preferences, budget } = intent;

    // Search for destinations
    const destinations = await this.searchDestinations(query);

    // Filter by preferences and budget
    const filtered = await this.filterDestinations(destinations, preferences, budget);

    // Get detailed information
    const enriched = await this.enrichDestinationData(filtered);

    // Rank by user preferences
    const ranked = await this.rankDestinations(enriched, preferences);

    return {
      destinations: ranked,
      searchMetadata: {
        query,
        resultsCount: ranked.length,
        confidence: this.calculateSearchConfidence(ranked)
      }
    };
  }
}
```

#### Booking Agent (`src/agents/booking-agent.ts`)
```typescript
export class BookingAgent extends TravelAgent {
  async handleIntent(intent: BookingIntent): Promise<BookingResponse> {
    const { type, criteria, userPreferences } = intent;

    switch (type) {
      case 'flight':
        return await this.handleFlightBooking(criteria);
      case 'hotel':
        return await this.handleHotelBooking(criteria);
      case 'package':
        return await this.handlePackageBooking(criteria);
      default:
        throw new Error(`Unsupported booking type: ${type}`);
    }
  }

  private async handleFlightBooking(criteria: FlightCriteria): Promise<FlightBookingResponse> {
    // Search flights using Amadeus API
    const flights = await this.getAmadeusService().searchFlights(criteria);

    // Filter and rank results
    const ranked = await this.rankFlights(flights, criteria.preferences);

    // Check for deals and alternatives
    const alternatives = await this.findAlternatives(criteria);

    return {
      flights: ranked,
      alternatives,
      searchCriteria: criteria,
      bookingOptions: await this.generateBookingOptions(ranked)
    };
  }
}
```

### 3. Meta Orchestrator Agent
Create a meta-agent that coordinates between specialized agents:

```typescript
export class MetaOrchestratorAgent extends TravelAgent {
  private weatherAgent: WeatherAgent;
  private destinationAgent: DestinationAgent;
  private bookingAgent: BookingAgent;
  private attractionsAgent: AttractionsAgent;

  async handleIntent(intent: TravelIntent): Promise<AgentResponse> {
    // Parse and route the intent
    const routingDecision = await this.routeIntent(intent);

    // Execute primary agent
    const primaryResponse = await this.executePrimaryAgent(routingDecision);

    // Determine if additional agents are needed
    const additionalAgents = await this.identifyAdditionalAgents(intent, primaryResponse);

    // Execute additional agents in parallel
    const additionalResponses = await Promise.all(
      additionalAgents.map(agent => agent.execute(intent))
    );

    // Blend all responses
    const blendedResponse = await this.blendResponses(primaryResponse, additionalResponses);

    // Validate and verify
    const validated = await this.validateResponse(blendedResponse);

    return validated;
  }

  private async routeIntent(intent: TravelIntent): Promise<RoutingDecision> {
    // Analyze intent to determine primary agent
    const analysis = await this.analyzeIntent(intent);

    return {
      primaryAgent: this.selectPrimaryAgent(analysis),
      confidence: analysis.confidence,
      additionalAgents: this.suggestAdditionalAgents(analysis)
    };
  }
}
```

## State Management with Durable Objects

### 1. Agent State Schema
```typescript
interface AgentState {
  agentId: string;
  sessionId: string;
  userId?: string;
  conversationHistory: ConversationTurn[];
  extractedSlots: Record<string, any>;
  preferences: UserPreferences;
  currentIntent: TravelIntent;
  context: ConversationContext;
  metadata: AgentMetadata;
}

interface ConversationTurn {
  id: string;
  timestamp: number;
  userMessage: string;
  agentResponse: AgentResponse;
  intent: TravelIntent;
  confidence: number;
}
```

### 2. State Persistence
```typescript
export class AgentStateManager {
  constructor(private storage: DurableObjectStorage) {}

  async saveState(state: AgentState): Promise<void> {
    await this.storage.put('agent_state', state);
    await this.storage.put('last_updated', Date.now());
  }

  async getState(): Promise<AgentState | null> {
    return await this.storage.get('agent_state');
  }

  async appendConversationTurn(turn: ConversationTurn): Promise<void> {
    const state = await this.getState();
    if (state) {
      state.conversationHistory.push(turn);
      await this.saveState(state);
    }
  }

  async updateSlots(slots: Record<string, any>): Promise<void> {
    const state = await this.getState();
    if (state) {
      state.extractedSlots = { ...state.extractedSlots, ...slots };
      await this.saveState(state);
    }
  }
}
```

### 3. Agent Communication
```typescript
export class AgentCommunicationHub {
  async sendMessage(fromAgent: string, toAgent: string, message: AgentMessage): Promise<void> {
    // Send message between agents via Durable Object RPC
    const targetAgent = await this.getAgentStub(toAgent);
    await targetAgent.receiveMessage(fromAgent, message);
  }

  async broadcastMessage(fromAgent: string, message: AgentMessage): Promise<void> {
    // Broadcast to all active agents in the session
    const activeAgents = await this.getActiveAgents();
    await Promise.all(
      activeAgents.map(agent => this.sendMessage(fromAgent, agent.id, message))
    );
  }
}
```

## Tool Integration

### 1. Tool Registry for Agents
```typescript
export class AgentToolRegistry {
  private tools: Map<string, AgentTool> = new Map();

  registerTool(name: string, tool: AgentTool): void {
    this.tools.set(name, tool);
  }

  async executeTool(name: string, params: any, context: AgentContext): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    return await tool.execute(params, context);
  }

  getAvailableTools(agentType: string): string[] {
    return Array.from(this.tools.keys()).filter(name =>
      this.tools.get(name)?.supportedAgents.includes(agentType)
    );
  }
}
```

### 2. Migrate Existing Tools
Convert existing tools to work with the new agent system:

```typescript
// Migrate from root/src/agent/tools/
export class WeatherTool implements AgentTool {
  supportedAgents = ['weather', 'meta'];

  async execute(params: WeatherParams, context: AgentContext): Promise<WeatherResult> {
    // Migrate logic from existing weather tool
    const { destination, dates } = params;

    // Use existing weather service logic
    const weatherData = await this.weatherService.getForecast(destination, dates);

    return {
      data: weatherData,
      confidence: this.calculateConfidence(weatherData),
      metadata: {
        source: 'weather-api',
        timestamp: Date.now()
      }
    };
  }
}
```

## Files to Create

### Agent Classes:
- `src/agents/base-agent.ts` - Base agent class
- `src/agents/meta-orchestrator.ts` - Meta orchestrator
- `src/agents/weather-agent.ts` - Weather specialist
- `src/agents/destination-agent.ts` - Destination specialist
- `src/agents/booking-agent.ts` - Booking specialist
- `src/agents/attractions-agent.ts` - Attractions specialist

### State Management:
- `src/core/agent-state-manager.ts` - State persistence
- `src/core/agent-communication.ts` - Inter-agent communication
- `src/types/agent-types.ts` - Agent type definitions

### Tool System:
- `src/tools/agent-tool-registry.ts` - Tool management
- `src/tools/weather-tool.ts` - Migrated weather tool
- `src/tools/amadeus-tool.ts` - Migrated Amadeus tool
- `src/tools/search-tool.ts` - Migrated search tool

## Migration Tasks

### 1. Analyze Current System
- [ ] Map all functions in meta_agent.ts
- [ ] Identify tool usage patterns
- [ ] Document state management requirements
- [ ] Analyze response blending logic

### 2. Create Agent Architecture
- [ ] Implement base Agent class
- [ ] Create specialized agent classes
- [ ] Implement meta orchestrator
- [ ] Set up agent communication system

### 3. Migrate Tools
- [ ] Convert existing tools to agent-compatible format
- [ ] Implement tool registry
- [ ] Update tool calling mechanisms
- [ ] Test tool integration

### 4. Implement State Management
- [ ] Create state persistence layer
- [ ] Implement conversation history
- [ ] Add slot management
- [ ] Test state consistency

## Success Criteria
- [ ] All agent classes implemented and functional
- [ ] Meta orchestrator routing working correctly
- [ ] State persistence with Durable Objects working
- [ ] Tool integration maintained
- [ ] Response quality preserved
- [ ] Performance parity achieved
- [ ] Agent communication functioning

## Testing Requirements
- Unit tests for each agent class
- Integration tests for agent coordination
- State persistence tests
- Tool integration tests
- Performance benchmarks
- Conversation flow validation

## Dependencies
- Cloudflare Agents SDK
- Durable Objects configuration (Task 12)
- Existing tool system analysis
- D1 database integration
- KV state caching
