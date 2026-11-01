import { interpret } from '@/lib/server/interpret';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = (request: Request) => interpret(request, 'pair');
