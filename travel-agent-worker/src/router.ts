/**
 * Simple router for Cloudflare Workers
 */
export class Router {
	private routes: Array<{
		method: string;
		path: string;
		handler: (request: Request) => Promise<Response>;
	}> = [];

	get(path: string, handler: (request: Request) => Promise<Response>) {
		this.routes.push({ method: 'GET', path, handler });
	}

	post(path: string, handler: (request: Request) => Promise<Response>) {
		this.routes.push({ method: 'POST', path, handler });
	}

	put(path: string, handler: (request: Request) => Promise<Response>) {
		this.routes.push({ method: 'PUT', path, handler });
	}

	delete(path: string, handler: (request: Request) => Promise<Response>) {
		this.routes.push({ method: 'DELETE', path, handler });
	}

	async handle(request: Request): Promise<Response | null> {
		const url = new URL(request.url);
		const method = request.method;
		const path = url.pathname;

		for (const route of this.routes) {
			if (route.method === method && this.matchPath(route.path, path)) {
				return await route.handler(request);
			}
		}

		return null;
	}

	private matchPath(routePath: string, requestPath: string): boolean {
		// Simple exact match for now
		// TODO: Add path parameter support if needed
		return routePath === requestPath;
	}
}
