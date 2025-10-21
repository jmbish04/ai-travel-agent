/**
 * Database models and types for D1 tables
 */

export interface Session {
	id: string;
	thread_id: string;
	user_id?: string;
	session_metadata: string; // JSON
	created_at: number;
	last_accessed_at: number;
	expires_at?: number;
}

export interface Message {
	id?: number;
	thread_id: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	created_at: number;
	sequence_number: number;
}

export interface Slot {
	id?: number;
	thread_id: string;
	slot_key: string;
	slot_value: string;
	category?: string;
	created_at: number;
	updated_at: number;
}

export interface ThreadState {
	thread_id: string;
	last_intent?: string;
	expected_missing?: string; // JSON array
	last_facts?: string; // JSON array
	last_decisions?: string; // JSON array
	last_reply?: string;
	last_user_message?: string;
	prev_user_message?: string;
	created_at: number;
	updated_at: number;
}

export interface Verification {
	id?: number;
	thread_id: string;
	verdict: 'pass' | 'warn' | 'fail';
	notes?: string; // JSON array
	scores?: string; // JSON object
	revised_answer?: string;
	reply?: string;
	created_at: number;
}

export interface TravelBooking {
	id: string;
	user_id?: string;
	thread_id?: string;
	booking_type: 'flight' | 'hotel' | 'attraction' | 'package';
	booking_data: string; // JSON object
	status: 'pending' | 'confirmed' | 'cancelled';
	created_at: number;
	updated_at: number;
}

export interface ScrapedData {
	id: string;
	url: string;
	scrape_type: 'hotel' | 'attraction' | 'flight' | 'general';
	r2_key: string;
	metadata?: string; // JSON object
	user_id?: string;
	session_id?: string;
	created_at: number;
}

export interface UserProfile {
	user_id: string;
	profile_data: string; // JSON object
	created_at: number;
	updated_at: number;
}

export interface EmbeddingMetadata {
	id: string;
	content_type: 'hotel' | 'attraction' | 'review' | 'content';
	source_id?: string;
	title?: string;
	description?: string;
	location?: string;
	tags?: string; // JSON array
	vectorize_id?: string;
	created_at: number;
}

export interface QueueLog {
	id?: number;
	queue_name: string;
	message_id?: string;
	status: 'pending' | 'processing' | 'completed' | 'failed';
	payload?: string; // JSON object
	error_message?: string;
	retry_count: number;
	created_at: number;
	processed_at?: number;
}

export interface Metric {
	id?: number;
	metric_name: string;
	metric_value: number;
	labels?: string; // JSON object
	created_at: number;
}

/**
 * Parsed types for JSON fields
 */
export interface SessionMetadata {
	id: string;
	createdAt: number;
	lastAccessedAt: number;
	expiresAt?: number;
	userId?: string;
}

export interface VerificationScores {
	relevance: number;
	grounding: number;
	coherence: number;
	context_consistency: number;
}

export interface BookingData {
	[key: string]: unknown;
}

export interface ScrapedMetadata {
	title?: string;
	description?: string;
	location?: string;
	price?: number;
	rating?: number;
	reviews?: number;
	images?: string[];
	[key: string]: unknown;
}

export interface UserProfileData {
	preferences?: {
		destinations?: string[];
		travelStyle?: string;
		budgetRange?: string;
		interests?: string[];
	};
	personalInfo?: {
		name?: string;
		email?: string;
		language?: string;
		timezone?: string;
	};
	[key: string]: unknown;
}

export interface MetricLabels {
	[key: string]: string;
}
