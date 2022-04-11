import type { EndpointHandler } from '../../../@types/astro';
import type { SSROptions } from '../../render/dev';
import { preload } from '../../render/dev/index.js';
import { isBuildingToSSR } from '../../util.js';
import { call as callEndpoint } from '../index.js';

export async function call(ssrOpts: SSROptions) {
	const [, renderHooks, mod] = await preload(ssrOpts);
	return await callEndpoint(mod as unknown as EndpointHandler, {
		...ssrOpts,
		renderHooks,
		ssr: isBuildingToSSR(ssrOpts.astroConfig),
	});
}
