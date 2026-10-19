export type UpstreamResponse = { status: number; body: Record<string, unknown>; cookie: string[] };
export type RequestOptions = { crypto?: string; cookie?: unknown; e_r?: unknown };
export type UpstreamRequest = (uri: string, data: Record<string, unknown>, options: RequestOptions) => Promise<UpstreamResponse>;
export type Endpoint = (query: Record<string, unknown>, request: UpstreamRequest) => Promise<UpstreamResponse>;
export const endpoints: Record<'qrKey' | 'qrCheck' | 'status' | 'refresh' | 'userPlaylists' | 'playlist' | 'songs' | 'daily' | 'recommended' | 'playback', Endpoint>;
export const encrypt: {
  weapi(data: Record<string, unknown>): Record<string, string>;
  eapi(uri: string, data: Record<string, unknown>): Record<string, string>;
  eapiReqDecrypt(input: string): { url: string; data: Record<string, unknown> } | null;
};
