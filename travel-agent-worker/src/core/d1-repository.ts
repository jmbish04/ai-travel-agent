/**
 * D1 Database Repository
 * Provides methods to interact with the D1 database
 */

import type {
        EmbeddingMetadata,
        Message,
        Metric,
        QueueLog,
        ScrapedData,
        Session,
        Slot,
        ThreadState,
        TravelBooking,
        UserProfile,
        Verification,
} from "../types/database";

type ScrapedDataInput = Omit<ScrapedData, "created_at" | "metadata"> & {
        metadata?: string | Record<string, unknown> | null;
};

export class D1Repository {
	constructor(private db: D1Database) {}

	// Session operations
	async createSession(
		session: Omit<Session, "created_at" | "last_accessed_at">,
	): Promise<void> {
		await this.db
			.prepare(`
				INSERT INTO sessions (id, thread_id, user_id, session_metadata, expires_at)
				VALUES (?, ?, ?, ?, ?)
			`)
			.bind(
				session.id,
				session.thread_id,
				session.user_id,
				session.session_metadata,
				session.expires_at,
			)
			.run();
	}

	async getSession(id: string): Promise<Session | null> {
		const result = await this.db
			.prepare("SELECT * FROM sessions WHERE id = ?")
			.bind(id)
			.first<Session>();
		return result || null;
	}

	async updateSessionAccess(id: string): Promise<void> {
		await this.db
			.prepare(
				"UPDATE sessions SET last_accessed_at = unixepoch() WHERE id = ?",
			)
			.bind(id)
			.run();
	}

	async deleteSession(id: string): Promise<void> {
		await this.db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
	}

	// Message operations
	async addMessage(message: Omit<Message, "id" | "created_at">): Promise<void> {
		await this.db
			.prepare(`
				INSERT INTO messages (thread_id, role, content, sequence_number)
				VALUES (?, ?, ?, ?)
			`)
			.bind(
				message.thread_id,
				message.role,
				message.content,
				message.sequence_number,
			)
			.run();
	}

	async getMessages(threadId: string, limit = 50): Promise<Message[]> {
		const results = await this.db
			.prepare(`
				SELECT * FROM messages
				WHERE thread_id = ?
				ORDER BY sequence_number DESC
				LIMIT ?
			`)
			.bind(threadId, limit)
			.all<Message>();
		return results.results.reverse(); // Return in chronological order
	}

	async getLatestSequenceNumber(threadId: string): Promise<number> {
		const result = await this.db
			.prepare(
				"SELECT MAX(sequence_number) as max_seq FROM messages WHERE thread_id = ?",
			)
			.bind(threadId)
			.first<{ max_seq: number | null }>();
		return result?.max_seq || 0;
	}

	// Slot operations
	async setSlot(
		slot: Omit<Slot, "id" | "created_at" | "updated_at">,
	): Promise<void> {
		await this.db
			.prepare(`
				INSERT OR REPLACE INTO slots (thread_id, slot_key, slot_value, category)
				VALUES (?, ?, ?, ?)
			`)
			.bind(slot.thread_id, slot.slot_key, slot.slot_value, slot.category)
			.run();
	}

	async getSlots(threadId: string): Promise<Record<string, string>> {
		const results = await this.db
			.prepare("SELECT slot_key, slot_value FROM slots WHERE thread_id = ?")
			.bind(threadId)
			.all<{ slot_key: string; slot_value: string }>();

		const slots: Record<string, string> = {};
		for (const row of results.results) {
			slots[row.slot_key] = row.slot_value;
		}
		return slots;
	}

	async removeSlots(threadId: string, keys: string[]): Promise<void> {
		if (keys.length === 0) return;

		const placeholders = keys.map(() => "?").join(",");
		await this.db
			.prepare(
				`DELETE FROM slots WHERE thread_id = ? AND slot_key IN (${placeholders})`,
			)
			.bind(threadId, ...keys)
			.run();
	}

	// Thread state operations
	async setThreadState(
		state: Omit<ThreadState, "created_at" | "updated_at">,
	): Promise<void> {
		await this.db
			.prepare(`
				INSERT OR REPLACE INTO thread_state
				(thread_id, last_intent, expected_missing, last_facts, last_decisions,
				 last_reply, last_user_message, prev_user_message)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`)
			.bind(
				state.thread_id,
				state.last_intent,
				state.expected_missing,
				state.last_facts,
				state.last_decisions,
				state.last_reply,
				state.last_user_message,
				state.prev_user_message,
			)
			.run();
	}

	async getThreadState(threadId: string): Promise<ThreadState | null> {
		const result = await this.db
			.prepare("SELECT * FROM thread_state WHERE thread_id = ?")
			.bind(threadId)
			.first<ThreadState>();
		return result || null;
	}

	// Verification operations
	async addVerification(
		verification: Omit<Verification, "id" | "created_at">,
	): Promise<void> {
		await this.db
			.prepare(`
				INSERT INTO verifications (thread_id, verdict, notes, scores, revised_answer, reply)
				VALUES (?, ?, ?, ?, ?, ?)
			`)
			.bind(
				verification.thread_id,
				verification.verdict,
				verification.notes,
				verification.scores,
				verification.revised_answer,
				verification.reply,
			)
			.run();
	}

	async getLatestVerification(threadId: string): Promise<Verification | null> {
		const result = await this.db
			.prepare(`
				SELECT * FROM verifications
				WHERE thread_id = ?
				ORDER BY created_at DESC
				LIMIT 1
			`)
			.bind(threadId)
			.first<Verification>();
		return result || null;
	}

	// Travel booking operations
	async createBooking(
		booking: Omit<TravelBooking, "created_at" | "updated_at">,
	): Promise<void> {
		await this.db
			.prepare(`
				INSERT INTO travel_bookings (id, user_id, thread_id, booking_type, booking_data, status)
				VALUES (?, ?, ?, ?, ?, ?)
			`)
			.bind(
				booking.id,
				booking.user_id,
				booking.thread_id,
				booking.booking_type,
				booking.booking_data,
				booking.status,
			)
			.run();
	}

	async getBooking(id: string): Promise<TravelBooking | null> {
		const result = await this.db
			.prepare("SELECT * FROM travel_bookings WHERE id = ?")
			.bind(id)
			.first<TravelBooking>();
		return result || null;
	}

	async getUserBookings(userId: string): Promise<TravelBooking[]> {
		const results = await this.db
			.prepare(
				"SELECT * FROM travel_bookings WHERE user_id = ? ORDER BY created_at DESC",
			)
			.bind(userId)
			.all<TravelBooking>();
		return results.results;
	}

	// Scraped data operations
        async addScrapedData(data: ScrapedDataInput): Promise<void> {
                const metadata =
                        typeof data.metadata === "string"
                                ? data.metadata
                                : data.metadata
                                        ? JSON.stringify(data.metadata)
                                        : null;

                await this.db
                        .prepare(`
                                INSERT INTO scraped_data (id, url, scrape_type, r2_key, metadata, user_id, session_id)
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                        `)
                        .bind(
                                data.id,
                                data.url,
                                data.scrape_type,
                                data.r2_key,
                                metadata,
                                data.user_id,
                                data.session_id,
                        )
                        .run();
        }

        async getScrapedData(id: string): Promise<ScrapedData | null> {
                const result = await this.db
                        .prepare("SELECT * FROM scraped_data WHERE id = ?")
                        .bind(id)
                        .first<ScrapedData>();
                return result || null;
        }

        async addScrapedDataRecord(data: {
                id?: string;
                url: string;
                scrapeType: ScrapedData["scrape_type"];
                r2Key: string;
                metadata?: Record<string, unknown>;
                userId?: string;
                sessionId?: string;
        }): Promise<string> {
                const recordId = data.id ?? crypto.randomUUID();
                await this.addScrapedData({
                        id: recordId,
                        url: data.url,
                        scrape_type: data.scrapeType,
                        r2_key: data.r2Key,
                        metadata: data.metadata ?? null,
                        user_id: data.userId,
                        session_id: data.sessionId,
                });
                return recordId;
        }

        async updateScrapedDataMetadata(
                id: string,
                metadata: Record<string, unknown>,
        ): Promise<void> {
                await this.db
                        .prepare("UPDATE scraped_data SET metadata = ? WHERE id = ?")
                        .bind(JSON.stringify(metadata), id)
                        .run();
        }

	// User profile operations
	async setUserProfile(
		profile: Omit<UserProfile, "created_at" | "updated_at">,
	): Promise<void> {
		await this.db
			.prepare(`
				INSERT OR REPLACE INTO user_profiles (user_id, profile_data)
				VALUES (?, ?)
			`)
			.bind(profile.user_id, profile.profile_data)
			.run();
	}

	async getUserProfile(userId: string): Promise<UserProfile | null> {
		const result = await this.db
			.prepare("SELECT * FROM user_profiles WHERE user_id = ?")
			.bind(userId)
			.first<UserProfile>();
		return result || null;
	}

	// Embedding metadata operations
	async addEmbeddingMetadata(
		metadata: Omit<EmbeddingMetadata, "created_at">,
	): Promise<void> {
		await this.db
			.prepare(`
				INSERT INTO embeddings_metadata
				(id, content_type, source_id, title, description, location, tags, vectorize_id)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`)
			.bind(
				metadata.id,
				metadata.content_type,
				metadata.source_id,
				metadata.title,
				metadata.description,
				metadata.location,
				metadata.tags,
				metadata.vectorize_id,
			)
			.run();
	}

	// Queue log operations
	async logQueueMessage(
		log: Omit<QueueLog, "id" | "created_at">,
	): Promise<void> {
		await this.db
			.prepare(`
				INSERT INTO queue_logs
				(queue_name, message_id, status, payload, error_message, retry_count, processed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`)
			.bind(
				log.queue_name,
				log.message_id,
				log.status,
				log.payload,
				log.error_message,
				log.retry_count,
				log.processed_at,
			)
			.run();
	}

	async updateQueueMessageStatus(
		messageId: string,
		status: "processing" | "completed" | "failed",
		errorMessage?: string,
	): Promise<void> {
		await this.db
			.prepare(`
				UPDATE queue_logs
				SET status = ?, error_message = ?, processed_at = unixepoch()
				WHERE message_id = ?
			`)
			.bind(status, errorMessage, messageId)
			.run();
	}

	// Metrics operations
	async addMetric(metric: Omit<Metric, "id" | "created_at">): Promise<void> {
		await this.db
			.prepare(`
				INSERT INTO metrics (metric_name, metric_value, labels)
				VALUES (?, ?, ?)
			`)
			.bind(metric.metric_name, metric.metric_value, metric.labels)
			.run();
	}

	async getMetrics(metricName: string, limit = 100): Promise<Metric[]> {
		const results = await this.db
			.prepare(`
				SELECT * FROM metrics
				WHERE metric_name = ?
				ORDER BY created_at DESC
				LIMIT ?
			`)
			.bind(metricName, limit)
			.all<Metric>();
		return results.results;
	}

	// Cleanup operations
	async cleanupExpiredSessions(): Promise<void> {
		await this.db
			.prepare(
				"DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < unixepoch()",
			)
			.run();
	}

	async cleanupOldMessages(retentionDays = 30): Promise<void> {
		const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 24 * 60 * 60;
		await this.db
			.prepare("DELETE FROM messages WHERE created_at < ?")
			.bind(cutoff)
			.run();
	}

	async cleanupOldMetrics(retentionDays = 7): Promise<void> {
		const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 24 * 60 * 60;
		await this.db
			.prepare("DELETE FROM metrics WHERE created_at < ?")
			.bind(cutoff)
			.run();
	}
}
