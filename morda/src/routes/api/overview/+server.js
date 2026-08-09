import { json } from '@sveltejs/kit';
import { overview } from '$lib/server/fleet.js';

export function GET() {
  return json(overview());
}
