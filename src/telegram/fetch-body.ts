const NATIVE_FETCH_BODY_TYPES = new Set(['FormData', 'Blob', 'Readable', 'ReadableStream']);

export function requiresNativeFetchBody(body: unknown): boolean {
    if (!body || typeof body !== 'object') return false;
    return NATIVE_FETCH_BODY_TYPES.has(body.constructor?.name || '');
}
