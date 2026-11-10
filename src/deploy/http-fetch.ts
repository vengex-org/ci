/** The part of `fetch` this package uses, so tests pass a typed fake instead of the network. */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>
