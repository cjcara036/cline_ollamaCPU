/**
 * # Network Support for Cline
 *
 * ## Development Guidelines
 *
 * **Do** use `import { fetch } from '@/shared/net'` instead of global `fetch`.
 *
 * Global `fetch` will appear to work in VSCode, but proxy support will be
 * broken in JetBrains or CLI.
 *
 * If you use Axios, **do** call `getAxiosSettings()` and spread into
 * your Axios configuration:
 *
 * ```typescript
 * import { getAxiosSettings } from '@/shared/net'
 * await axios.get(url, {
 *   headers: { 'X-FOO': 'BAR' },
 *   ...getAxiosSettings()
 * })
 * ```
 *
 * **Do** remember to pass our `fetch` into your API clients:
 *
 * ```typescript
 * import OpenAI from "openai"
 * import { fetch } from "@/shared/net"
 * this.client = new OpenAI({
 *   apiKey: '...',
 *   fetch, // Use configured fetch with proxy support
 * })
 * ```
 *
 * If you neglect this step, inference won't work in JetBrains and CLI
 * through proxies.
 *
 * ## Proxy Support
 *
 * Cline uses platform-specific fetch implementations to handle proxy
 * configuration:
 * - **VSCode**: Uses global fetch (VSCode provides proxy configuration)
 * - **JetBrains, CLI**: Uses undici fetch with explicit ProxyAgent
 *
 * Proxy configuration via standard environment variables:
 * - `http_proxy` / `HTTP_PROXY` - Proxy for HTTP requests
 * - `https_proxy` / `HTTPS_PROXY` - Proxy for HTTPS requests
 * - `no_proxy` / `NO_PROXY` - Comma-separated list of hosts to bypass proxy
 *
 * Note, `http_proxy` etc. MUST specify the protocol to use for the proxy,
 * for example, `https_proxy=http://proxy.corp.example:3128`. Simply specifying
 * the proxy hostname will result in errors.
 *
 * ## Certificate Trust
 *
 * Proxies often machine-in-the-middle HTTPS connections. To make this work,
 * they generate self-signed certificates for a host, and the client is
 * configured to trust the proxy as a certificate authority.
 *
 * VSCode transparently pulls trusted certificates from the operating system
 * and configures node trust.
 *
 * JetBrains exports trusted certificates from the OS and writes them to a
 * temporary file, then configures node TLS by setting NODE_EXTRA_CA_CERTS.
 *
 * CLI users should set the NODE_EXTRA_CA_CERTS environment variable if
 * necessary, because node does not automatically use the OS' trusted certs.
 *
 * ## Limitations in JetBrains & CLI
 *
 * - Proxy settings are static at startup--restart required for changes
 * - SOCKS proxies, PAC files not supported
 * - Proxy authentication via env vars only
 *
 * These are not fundamental limitations, they just need integration work.
 *
 * ## Troubleshooting
 *
 * 1. Verify proxy env vars: `echo $http_proxy $https_proxy`
 * 2. Check certificates: `echo $NODE_EXTRA_CA_CERTS` (should point to PEM file)
 * 3. View logs: Check ~/.cline/cline-core-service.log for network-related
 *    failures.
 * 4. Test connection: Use `curl -x host:port` etc. to isolate proxy
 *    configuration versus client issues.
 *
 * @example
 * ```typescript
 * // Good - uses configured fetch
 * import { fetch } from '@/shared/net'
 * const response = await fetch(url)
 *
 * // Good - configures axios to use configured fetch
 * import { getAxiosSettings } from '@/shared/net'
 * await axios.get(url, { ...getAxiosSettings() })
 * ```
 */
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from "undici"

export const fetch: typeof globalThis.fetch = (() => {
    const baseFetch = globalThis.fetch; 
    
    // 1. Internet Agent (Proxy + Unlimited Timeout)
    const proxyAgent = new EnvHttpProxyAgent({
        headersTimeout: 0, connectTimeout: 0, keepAliveTimeout: 0, bodyTimeout: 0
    });

    // 2. Localhost Agent (Direct + Unlimited Timeout)
    const localAgent = new Agent({
        headersTimeout: 0, connectTimeout: 0, keepAliveTimeout: 0, bodyTimeout: 0,
        // [FIXED] Removed 'pipelining: 0' (Invalid) and 'allowH2' (Invalid for Agent)
        keepAlive: true,
        pipelining: 1 
    });

    return async (input: any, init?: any): Promise<Response> => {
        try {
            // --- 1. RESOLVE URL ---
            let url: string = '';
            if (typeof input === 'string') {
                url = input;
            } else if (input instanceof URL) {
                url = input.href;
            } else if (typeof input === 'object' && input !== null && 'url' in input) {
                url = input.url;
            } else {
                throw new Error("Cannot parse URL");
            }

            // Force IPv4 for Windows Localhost
            if (url.includes('localhost')) {
                url = url.replace('localhost', '127.0.0.1');
            }

            // --- 2. SELECT DISPATCHER ---
            const isLocal = url.includes('127.0.0.1') || url.includes('0.0.0.0');
            const selectedDispatcher = isLocal ? localAgent : proxyAgent;

            // --- 3. PREPARE RAW DATA ---
            let method = 'GET';
            let headers: any = {};
            let rawBody: any = undefined;

            if (typeof input === 'object' && input !== null && 'method' in input) {
                method = input.method;
                rawBody = input.body;
                headers = input.headers;
            }
            if (init) {
                if (init.method) method = init.method;
                if (init.body) rawBody = init.body;
                if (init.headers) headers = init.headers;
            }

            // --- 4. BUFFER THE BODY (Reliability Fix) ---
            let finalBody = rawBody;
            if (rawBody && typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) {
                try {
                    finalBody = await new Response(rawBody).text();
                } catch (e) {
                    try { finalBody = JSON.stringify(rawBody); } catch (e2) { finalBody = String(rawBody); }
                }
            }

            // --- 5. CLEAN HEADERS ---
            const cleanHeaders: Record<string, string> = {};
            if (headers) {
                if (typeof headers.entries === 'function' && !Array.isArray(headers)) {
                    for (const [key, value] of headers.entries()) {
                        cleanHeaders[key] = String(value);
                    }
                } else if (typeof headers === 'object') {
                    for (const key in headers) {
                         if (Object.prototype.hasOwnProperty.call(headers, key)) {
                            cleanHeaders[key] = String(headers[key]);
                         }
                    }
                }
            }
            if (isLocal) cleanHeaders['Host'] = '127.0.0.1';

            // --- 6. SEND ---
            const fetchOptions: any = {
                method: method.toUpperCase(),
                headers: cleanHeaders,
                body: finalBody,
                dispatcher: selectedDispatcher
            };

            return await undiciFetch(url, fetchOptions) as any;

        } catch (err: any) {
            const cause = err.cause ? JSON.stringify(err.cause) : "Unknown";
            console.warn(`[Net-Wrapper] ⚠️ SAFETY NET ACTIVE. Undici Error: ${err.message} | Cause: ${cause}`);
            return baseFetch(input, init);
        }
    };
})();
/**
 * Mocks `fetch` for testing and calls `callback`. Then restores `fetch`. If the
 * specified callback returns a Promise, the fetch is restored when that Promise
 * is settled.
 * @param theFetch the replacement function to call to implement `fetch`.
 * @param callback `fetch` will be mocked for the duration of `callback()`.
 * @returns the result of `callback()`.
 */
export function mockFetchForTesting<T>(theFetch: typeof globalThis.fetch, callback: () => T): T {
	const originalMockFetch = mockFetch
	mockFetch = theFetch
	let willResetSync = true
	try {
		const result = callback()
		if (result instanceof Promise) {
			willResetSync = false
			return result.finally(() => {
				mockFetch = originalMockFetch
			}) as typeof result
		} else {
			return result
		}
	} finally {
		if (willResetSync) {
			mockFetch = originalMockFetch
		}
	}
}

/**
 * Returns axios configuration for fetch adapter mode with our configured fetch.
 * This ensures axios uses our platform-specific fetch implementation with
 * proper proxy configuration.
 *
 * @returns Configuration object with fetch adapter and configured fetch
 *
 * @example
 * ```typescript
 * const response = await axios.get(url, {
 *   headers: { Authorization: 'Bearer token' },
 *   timeout: 5000,
 *   ...getAxiosSettings()
 * })
 * ```
 */
export function getAxiosSettings(): { adapter?: any; fetch?: typeof globalThis.fetch } {
	return {
		adapter: "fetch" as any,
		fetch, // Use our configured fetch
	}
}
