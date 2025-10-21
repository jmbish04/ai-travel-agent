/**
 * Logger utility for Cloudflare Workers
 */
export interface Logger {
	info(obj: any, msg?: string): void;
	warn(obj: any, msg?: string): void;
	error(obj: any, msg?: string): void;
	debug(obj: any, msg?: string): void;
}

export function createLogger(): Logger {
	return {
		info(obj: any, msg?: string) {
			console.log('INFO:', msg || '', obj);
		},
		warn(obj: any, msg?: string) {
			console.warn('WARN:', msg || '', obj);
		},
		error(obj: any, msg?: string) {
			console.error('ERROR:', msg || '', obj);
		},
		debug(obj: any, msg?: string) {
			console.debug('DEBUG:', msg || '', obj);
		}
	};
}
