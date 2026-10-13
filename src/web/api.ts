// Calls to the server. Every change carries the x-gungnir header the server requires.
import type { Account, ActivityEntry, Candidate, Client, Media, Post, PostInput, ServerStatus, User } from '../shared/types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'x-gungnir': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('gungnir:signed-out'));
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

/** Uploads with progress (fetch can't report upload progress). Fields go before the file so the server sees them. */
export function uploadMedia(clientId: string, file: File, info: { width?: number; height?: number; durationMs?: number }, onProgress: (fraction: number) => void): Promise<Media> {
  return new Promise((resolve, reject) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(info)) if (v) data.append(k, String(Math.round(v)));
    data.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/clients/${clientId}/media`);
    xhr.setRequestHeader('x-gungnir', '1');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* empty */
      }
      if (xhr.status < 300) resolve(body as Media);
      else reject(new ApiError(xhr.status, body?.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'The upload was interrupted. Check your connection and try again.'));
    xhr.send(data);
  });
}

export const api = {
  status: () => call<ServerStatus>('GET', '/api/status'),
  me: () => call<User>('GET', '/api/me'),
  setup: (b: { email: string; name: string; password: string }) => call<User>('POST', '/api/setup', b),
  login: (b: { email: string; password: string }) => call<User>('POST', '/api/login', b),
  logout: () => call('POST', '/api/logout', {}),
  changePassword: (b: { current: string; password: string }) => call('PUT', '/api/me/password', b),
  users: () => call<User[]>('GET', '/api/users'),
  updateUser: (id: string, b: { role?: string; disabled?: boolean }) => call<User>('PATCH', `/api/users/${id}`, b),
  invites: () => call<{ id: string; email: string; role: string; expiresAt: number }[]>('GET', '/api/invites'),
  invite: (b: { email: string; role: string }) => call<{ link: string; email: string }>('POST', '/api/invites', b),
  deleteInvite: (id: string) => call('DELETE', `/api/invites/${id}`),
  checkInvite: (token: string) => call<{ email: string }>('GET', `/api/invites/check?token=${encodeURIComponent(token)}`),
  acceptInvite: (b: { token: string; name: string; password: string }) => call<User>('POST', '/api/invites/accept', b),
  clients: () => call<Client[]>('GET', '/api/clients'),
  client: (id: string) => call<Client>('GET', `/api/clients/${id}`),
  createClient: (b: { name: string }) => call<Client>('POST', '/api/clients', b),
  updateClient: (id: string, b: { name?: string; notes?: string; archived?: boolean }) => call<Client>('PATCH', `/api/clients/${id}`, b),
  deleteClient: (id: string) => call('DELETE', `/api/clients/${id}`),
  removeAccount: (id: string) => call('DELETE', `/api/accounts/${id}`),
  refreshAccount: (id: string) => call<Account>('POST', `/api/accounts/${id}/refresh`, {}),
  candidates: (connectionId: string) => call<Candidate[]>('GET', `/api/connect/candidates/${connectionId}`),
  addCandidates: (connectionId: string, ids: string[]) => call<Account[]>('POST', `/api/connect/candidates/${connectionId}`, { ids }),
  media: (clientId: string) => call<Media[]>('GET', `/api/clients/${clientId}/media`),
  deleteMedia: (id: string) => call('DELETE', `/api/media/${id}`),
  posts: (q: { clientId?: string } = {}) => call<Post[]>('GET', `/api/posts${q.clientId ? `?clientId=${q.clientId}` : ''}`),
  post: (id: string) => call<Post>('GET', `/api/posts/${id}`),
  activity: (id: string) => call<ActivityEntry[]>('GET', `/api/posts/${id}/activity`),
  createPost: (b: PostInput) => call<Post>('POST', '/api/posts', b),
  updatePost: (id: string, b: PostInput) => call<Post>('PUT', `/api/posts/${id}`, b),
  cancelPost: (id: string) => call<Post>('POST', `/api/posts/${id}/cancel`, {}),
  deletePost: (id: string) => call('DELETE', `/api/posts/${id}`),
  retryTarget: (id: string) => call<Post>('POST', `/api/targets/${id}/retry`, {}),
};

export const mediaUrl = (id: string) => `/api/media/${id}/file`;
export const connectUrl = (provider: string, clientId: string) => `/api/connect/${provider}/start?clientId=${encodeURIComponent(clientId)}`;
