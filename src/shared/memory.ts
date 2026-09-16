import { z } from 'zod';

export const memoryLinkSchema = z.object({
  ref: z.string().min(1).max(300),
  role: z.string().trim().min(1).max(80).default('related'),
});
export const memoryWriteSchema = z.object({
  text: z.string().trim().min(1).max(16000),
  links: z.array(memoryLinkSchema).max(12).default([]),
  sources: z.array(z.string().min(1).max(300)).max(12).default([]),
});
export type MemoryWrite = z.infer<typeof memoryWriteSchema>;
export type MemoryItem = {
  id: string;
  ref: string;
  revisionId: string;
  title: string;
  preview: string;
  origin: string;
  state: 'active' | 'retired';
  updatedAt: string;
  links: number;
  sources: number;
  capturedSource?: MemorySource;
};
export type MemorySource = {
  conversationId: string;
  messageId: string;
  title: string;
  role: 'user' | 'assistant' | 'tool';
  createdAt: number;
  truncated: boolean;
};
export type MemoryUse = { items: MemoryItem[]; tokens: number; partial: boolean };
export type MemoryUsage = {
  conversationId: string;
  messageId: string;
  at: number;
  revisionId: string;
};
export type MemoryDetail = {
  item: MemoryItem;
  text: string;
  latestRevisionId: string;
  links: { role: string; item?: MemoryItem; unavailable?: boolean }[];
  incoming: MemoryItem[];
  sources: { item?: MemoryItem; unavailable?: boolean }[];
  history: MemoryItem[];
  historyCursor?: string;
  usedIn: MemoryUsage[];
  stale: boolean;
};
export type MemoryJob = {
  conversationId: string;
  title: string;
  cursor: number;
  requestedThrough: number;
  state: 'queued' | 'running' | 'complete' | 'error';
  updatedAt: number;
  error?: string;
  saved: number;
};
export type MemoryPage = {
  items: MemoryItem[];
  cursor?: string;
  total: number;
  sourceCount: number;
  linkCount: number;
  partial: boolean;
  jobs: MemoryJob[];
  automatic: boolean;
};
