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

import { EnvHttpProxyAgent, setGlobalDispatcher, fetch as undiciFetch } from "undici"

let mockFetch: typeof globalThis.fetch | undefined

/**
 * Platform-configured fetch that respects proxy settings and removes default timeouts.
 */
export const fetch: typeof globalThis.fetch = (() => {
    // Note: Don't use Logger here; it may not be initialized.

    let baseFetch: any = globalThis.fetch

    const agent = new EnvHttpProxyAgent({
        headersTimeout: 0,
        connectTimeout: 0,
        keepAliveTimeout: 0,
        bodyTimeout: 0,
    })

    if (process.env.IS_STANDALONE) {
        setGlobalDispatcher(agent)
        baseFetch = undiciFetch
    } else {
        baseFetch = (input: any, init: any) => {
            
            // --- SANITIZATION START ---
            let url: string;
            let options = init || {};

            try {
                // Case 1: Input is already a string
                if (typeof input === 'string') {
                    url = input;
                }
                // Case 2: Input is a URL Object (has .href)
                else if (input instanceof URL) {
                    url = input.href;
                }
                // Case 3: Input is a Request Object (has .url)
                else if (typeof input === 'object' && input !== null && 'url' in input) {
                    url = input.url;
                    // Merge properties from the Request object
                    options = {
                        method: input.method,
                        headers: input.headers,
                        body: input.body,
                        signal: input.signal,
                        ...options // init options take precedence
                    };
                }
                // Case 4: Fallback (Try to stringify)
                else {
                    url = String(input);
                }

                // Fix Headers: Convert Headers object to plain object
                if (options.headers && typeof options.headers.entries === 'function' && !Array.isArray(options.headers)) {
                    const headers: Record<string, string> = {};
                    for (const [key, value] of options.headers.entries()) {
                        headers[key] = value;
                    }
                    options.headers = headers;
                }

                // Add 'duplex' for streams (Required by undici)
                if (options.body && !options.duplex) {
                    options.duplex = 'half';
                }

            } catch (e) {
                console.error("[Net-Wrapper] Error sanitizing args:", e);
                // Fallback to original input if sanitization explodes
                url = input;
            }
            // --- SANITIZATION END ---

            // Console log to debug if it still fails (View in Help > Toggle Developer Tools)
            // console.log("[Net-Wrapper] Fetching:", url);

            return undiciFetch(url, {
                ...options,
                dispatcher: agent,
            } as any)
        }
    }

    // Force return type to Promise<Response> to satisfy TypeScript
    return (input: any, init?: any): Promise<Response> => {
        return (mockFetch || baseFetch)(input, init) as Promise<Response>
    }
})()
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
