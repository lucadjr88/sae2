export function getCache(namespace: string, key: string): Promise<any | null>;
export function setCache(namespace: string, key: string, data: any): Promise<void>;
export function getCacheDataOnly(namespace: string, key: string): Promise<any | null>;
export function getCacheWithTimestamp(namespace: string, key: string): Promise<{ data: any; savedAt: number } | null>;
export function deleteCache(namespace: string, key: string): Promise<void>;
