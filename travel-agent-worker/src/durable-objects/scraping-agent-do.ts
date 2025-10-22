import { BaseAgentDO } from "./base-agent-do";
import type {
        AgentContext,
        AgentMessage,
        AgentResponse,
        AgentState,
} from "../types/durable-object-types";
import type { WorkerEnv } from "../types/env";
import { createAgentResponse } from "../utils/do-helpers";

interface ScrapeTask {
        id: string;
        url: string;
        status: 'queued' | 'completed' | 'failed' | 'processing';
        createdAt: number;
        updatedAt: number;
        metadata: Record<string, unknown>;
        result?: unknown;
        error?: string;
}

export class ScrapingAgentDO extends BaseAgentDO {
        constructor(state: DurableObjectState, env: WorkerEnv) {
                super(state, env);
        }

        protected override createInitialState(): AgentState {
                const base = super.createInitialState();
                return {
                        ...base,
                        context: { ...base.context, agentType: "scraping" },
                        cache: { tasks: {} },
                };
        }

        protected async handleMessage(message: AgentMessage): Promise<AgentResponse> {
                const context = message.context ?? {};
                switch (message.type) {
                        case "queue_task":
                                return this.queueTask(message.content, context);
                        case "complete_task":
                                return this.completeTask(message.content, context);
                        case "status":
                                return this.getStatus(message.content);
                        default:
                                return createAgentResponse({
                                        type: "error",
                                        status: "error",
                                        content: null,
                                        error: `Unsupported message type: ${message.type}`,
                                });
                }
        }

        private async queueTask(content: unknown, context: AgentContext): Promise<AgentResponse> {
                const payload = (content as Record<string, unknown>) ?? {};
                const url = typeof payload.url === "string" ? payload.url : String(payload.url ?? "");
                const taskId =
                        (typeof payload.id === "string" && payload.id) ||
                        (typeof payload.taskId === "string" && payload.taskId) ||
                        crypto.randomUUID();

                const state = await this.getState();
                const tasks = this.getTasks(state);
                const now = Date.now();
                const task: ScrapeTask = {
                        id: taskId,
                        url,
                        status: "queued",
                        createdAt: now,
                        updatedAt: now,
                        metadata: {
                                ...context,
                                ...(typeof payload.metadata === "object" && payload.metadata !== null
                                        ? (payload.metadata as Record<string, unknown>)
                                        : {}),
                        },
                };

                tasks[taskId] = task;

                await this.updateTasks(tasks);
                await this.addTaskHistory(task, "queued");

                return createAgentResponse({
                        type: "task_queued",
                        content: task,
                        metadata: { context },
                });
        }

        private async completeTask(content: unknown, context: AgentContext): Promise<AgentResponse> {
                const payload = (content as Record<string, unknown>) ?? {};
                const taskId = typeof payload.id === "string" ? payload.id : (payload.taskId as string | undefined);
                if (!taskId) {
                        return createAgentResponse({
                                type: "task_update",
                                status: "error",
                                content: null,
                                error: "Missing task identifier",
                        });
                }

                const state = await this.getState();
                const tasks = this.getTasks(state);
                const task = tasks[taskId];
                if (!task) {
                        return createAgentResponse({
                                type: "task_update",
                                status: "error",
                                content: null,
                                error: "Task not found",
                        });
                }

                const status = (payload.status as ScrapeTask['status']) ?? "completed";
                const now = Date.now();

                tasks[taskId] = {
                        ...task,
                        status,
                        updatedAt: now,
                        result: payload.result,
                        error: typeof payload.error === "string" ? payload.error : undefined,
                };

                await this.updateTasks(tasks);
                await this.addTaskHistory(tasks[taskId], "updated", context);

                return createAgentResponse({
                        type: "task_update",
                        content: tasks[taskId],
                        metadata: { context },
                });
        }

        private async getStatus(content: unknown): Promise<AgentResponse> {
                const payload = (content as Record<string, unknown>) ?? {};
                const state = await this.getState();
                const tasks = this.getTasks(state);

                if (typeof payload.id === "string" || typeof payload.taskId === "string") {
                        const taskId = (payload.id ?? payload.taskId) as string;
                        const task = tasks[taskId];
                        if (!task) {
                                return createAgentResponse({
                                        type: "task_status",
                                        status: "error",
                                        content: null,
                                        error: "Task not found",
                                });
                        }

                        return createAgentResponse({
                                type: "task_status",
                                content: task,
                        });
                }

                const allTasks = Object.values(tasks).sort((a, b) => b.updatedAt - a.updatedAt);
                return createAgentResponse({
                        type: "task_status_list",
                        content: {
                                total: allTasks.length,
                                tasks: allTasks,
                        },
                });
        }

        private getTasks(state: AgentState): Record<string, ScrapeTask> {
                const cache = state.cache ?? {};
                const tasks = cache.tasks as Record<string, ScrapeTask> | undefined;
                return { ...(tasks ?? {}) };
        }

        private async updateTasks(tasks: Record<string, ScrapeTask>): Promise<void> {
                const state = await this.getState();
                await this.updateState({
                        cache: { ...(state.cache ?? {}), tasks },
                });
        }

        private async addTaskHistory(task: ScrapeTask, action: string, context: AgentContext = {}): Promise<void> {
                await this.addToConversationHistory({
                        id: crypto.randomUUID(),
                        role: "system",
                        payloadType: "message",
                        payload: {
                                id: crypto.randomUUID(),
                                type: "task_event",
                                content: { action, task, context },
                        },
                        timestamp: Date.now(),
                });
        }
}
