import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
  loader: glob({ base: './source/_posts', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string(),
    date: z.union([z.string(), z.date()]),
    draft: z.boolean().default(false),
    tags: z.array(z.string()).max(8).default([]),
    categories: z.array(z.enum(['AI 应用', '工程化', '架构', '思考', '踩坑', '后端基础', '技术分享'])).length(1),
    description: z.string().optional(),
  }),
});

export const collections = { posts };
