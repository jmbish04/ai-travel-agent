import type {
        AgentMessage,
        AgentResponse,
        AgentState,
        ConversationEntry,
} from "../types/durable-object-types";
import type { WorkerEnv } from "../types/env";

/**
 * Shared base implementation for agent-oriented Durable Objects.
 */
export abstract class BaseAgentDO implements DurableObject {
        protected readonly state: DurableObjectState;
        protected readonly storage: DurableObjectStorage;
        protected readonly env: WorkerEnv;
        private initialized = false;

        constructor(state: DurableObjectState, env: WorkerEnv) {
                this.state = state;
                this.storage = state.storage;
                this.env = env;

                state.blockConcurrencyWhile(async () => {
                        await this.onStart();
                        this.initialized = true;
                });
        }

        /**
         * Key used for persisting the agent state payload.
         */
        protected get stateStorageKey(): string {
                return "state";
        }

        /**
         * Maximum number of history entries kept in memory/storage per agent.
         */
        protected get maxHistoryEntries(): number {
                return 200;
        }

        /**
         * Durable Object fetch handler.
         */
        async fetch(request: Request): Promise<Response> {
                if (!this.initialized) {
                        await this.onStart();
                        this.initialized = true;
                }

                const url = new URL(request.url);
                const method = request.method.toUpperCase();

                try {
                        if (url.pathname === "/message" && method === "POST") {
                                const message = (await request.json()) as AgentMessage;
                                if (!message || typeof message.type !== "string") {
                                        return new Response(
                                                JSON.stringify({ error: "invalid_message" }),
                                                {
                                                        status: 400,
                                                        headers: { "Content-Type": "application/json" },
                                                },
                                        );
                                }

                                const response = await this.handleMessage(message);
                                this.state.waitUntil(this.persistState());
                                return new Response(JSON.stringify(response), {
                                        headers: { "Content-Type": "application/json" },
                                });
                        }

                        if (url.pathname === "/state" && method === "GET") {
                                const state = await this.getState();
                                return new Response(JSON.stringify(state), {
                                        headers: { "Content-Type": "application/json" },
                                });
                        }

                        if (url.pathname === "/health" && method === "GET") {
                                return new Response(
                                        JSON.stringify({ status: "healthy", timestamp: Date.now() }),
                                        {
                                                headers: { "Content-Type": "application/json" },
                                        },
                                );
                        }
                } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return new Response(JSON.stringify({ error: message }), {
                                status: 500,
                                headers: { "Content-Type": "application/json" },
                        });
                }

                return new Response("Not Found", { status: 404 });
        }

        /**
         * Processes a message directed to the durable object instance.
         */
        protected abstract handleMessage(message: AgentMessage): Promise<AgentResponse>;

        /**
         * Initializes durable object state on first run.
         */
        protected async onStart(): Promise<void> {
                const existing = await this.storage.get<AgentState>(this.stateStorageKey);
                if (!existing) {
                        await this.storage.put(this.stateStorageKey, this.createInitialState());
                }
        }

        /**
         * Hook invoked when the object is quiescent. Ensures timestamps stay up-to-date.
         */
        protected async onStop(): Promise<void> {
                await this.persistState();
        }

        /**
         * Persists the current state by updating the lastUpdated timestamp.
         */
        protected async persistState(): Promise<void> {
                const current = await this.storage.get<AgentState>(this.stateStorageKey);
                if (current) {
                        current.lastUpdated = Date.now();
                        await this.storage.put(this.stateStorageKey, current);
                }
        }

        /**
         * Retrieves the current state snapshot for the durable object.
         */
        protected async getState(): Promise<AgentState> {
                const state = await this.storage.get<AgentState>(this.stateStorageKey);
                if (state) {
                        return state;
                }

                const initial = this.createInitialState();
                await this.storage.put(this.stateStorageKey, initial);
                return initial;
        }

        /**
         * Applies partial updates to the persisted state.
         */
        protected async updateState(updates: Partial<AgentState>): Promise<void> {
                const current = await this.getState();
                const next: AgentState = {
                        ...current,
                        ...updates,
                        context: { ...current.context, ...(updates.context ?? {}) },
                        conversationHistory: updates.conversationHistory ?? current.conversationHistory,
                        extractedSlots: { ...current.extractedSlots, ...(updates.extractedSlots ?? {}) },
                        preferences: { ...current.preferences, ...(updates.preferences ?? {}) },
                        lastUpdated: Date.now(),
                };

                await this.storage.put(this.stateStorageKey, next);
        }

        /**
         * Creates the default state structure for the durable object.
         */
        protected createInitialState(): AgentState {
                const now = Date.now();
                return {
                        id: crypto.randomUUID(),
                        createdAt: now,
                        lastUpdated: now,
                        conversationHistory: [],
                        extractedSlots: {},
                        preferences: {},
                        context: {},
                        cache: {},
                };
        }

        /**
         * Appends a conversation entry to the persisted history, trimming overflow.
         */
        protected async addToConversationHistory(entry: ConversationEntry): Promise<void> {
                const state = await this.getState();
                const history = [...state.conversationHistory, entry];

                if (history.length > this.maxHistoryEntries) {
                        history.splice(0, history.length - this.maxHistoryEntries);
                }

                await this.updateState({
                        conversationHistory: history,
                });
        }
}
