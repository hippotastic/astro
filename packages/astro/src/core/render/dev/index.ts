import astroRemark from '@astrojs/markdown-remark';
import { fileURLToPath } from 'url';
import type * as vite from 'vite';
import type {
	AstroConfig,
	AstroRenderer,
	AstroRenderHook,
	ComponentInstance,
	RouteData,
	RuntimeMode,
	SSRElement,
	SSRLoadedRenderer,
	SSRLoadedRenderHook,
} from '../../../@types/astro';
import { LogOptions } from '../../logger/core.js';
import { render as coreRender } from '../core.js';
import { prependForwardSlash } from '../../../core/path.js';
import { RouteCache } from '../route-cache.js';
import { createModuleScriptElementWithSrcSet } from '../ssr-element.js';
import { getStylesForURL } from './css.js';
import { getHmrScript } from './hmr.js';
import { injectTags } from './html.js';
import { isBuildingToSSR } from '../../util.js';

export interface SSROptions {
	/** an instance of the AstroConfig */
	astroConfig: AstroConfig;
	/** location of file on disk */
	filePath: URL;
	/** logging options */
	logging: LogOptions;
	/** "development" or "production" */
	mode: RuntimeMode;
	/** production website, needed for some RSS functions */
	origin: string;
	/** the web request (needed for dynamic routes) */
	pathname: string;
	/** optional, in case we need to render something outside of a dev server */
	route?: RouteData;
	/** pass in route cache because SSR can’t manage cache-busting */
	routeCache: RouteCache;
	/** Vite instance */
	viteServer: vite.ViteDevServer;
	/** Request */
	request: Request;
}

export type ComponentPreload = [SSRLoadedRenderer[], SSRLoadedRenderHook[], ComponentInstance];

export type RenderResponse =
	| { type: 'html'; html: string }
	| { type: 'response'; response: Response };

const svelteStylesRE = /svelte\?svelte&type=style/;

async function loadRenderer(
	viteServer: vite.ViteDevServer,
	renderer: AstroRenderer
): Promise<SSRLoadedRenderer> {
	// Vite modules can be out-of-date when using an un-resolved url
	// We also encountered inconsistencies when using the resolveUrl and resolveId helpers
	// We've found that pulling the ID directly from the urlToModuleMap is the most stable!
	const id =
		viteServer.moduleGraph.urlToModuleMap.get(renderer.serverEntrypoint)?.id ??
		renderer.serverEntrypoint;
	const mod = (await viteServer.ssrLoadModule(id)) as { default: SSRLoadedRenderer['ssr'] };
	return { ...renderer, ssr: mod.default };
}

export async function loadRenderers(
	viteServer: vite.ViteDevServer,
	astroConfig: AstroConfig
): Promise<SSRLoadedRenderer[]> {
	return Promise.all(astroConfig._ctx.renderers.map((r) => loadRenderer(viteServer, r)));
}

async function loadRenderHook(
	viteServer: vite.ViteDevServer,
	renderHook: AstroRenderHook
): Promise<SSRLoadedRenderHook> {
	// Vite modules can be out-of-date when using an un-resolved url
	// We also encountered inconsistencies when using the resolveUrl and resolveId helpers
	// We've found that pulling the ID directly from the urlToModuleMap is the most stable!
	const id =
		viteServer.moduleGraph.urlToModuleMap.get(renderHook.hookEntrypoint)?.id ??
		renderHook.hookEntrypoint;
	const mod = (await viteServer.ssrLoadModule(id)) as { default: SSRLoadedRenderHook['ssr'] };
	return { ...renderHook, ssr: mod.default };
}

export async function loadRenderHooks(
	viteServer: vite.ViteDevServer,
	astroConfig: AstroConfig
): Promise<SSRLoadedRenderHook[]> {
	return Promise.all(astroConfig._ctx.renderHooks.map((rh) => loadRenderHook(viteServer, rh)));
}

export async function preload({
	astroConfig,
	filePath,
	viteServer,
}: Pick<SSROptions, 'astroConfig' | 'filePath' | 'viteServer'>): Promise<ComponentPreload> {
	// Important: This needs to happen first, in case a renderer provides polyfills.
	const renderers = await loadRenderers(viteServer, astroConfig);
	const renderHooks = await loadRenderHooks(viteServer, astroConfig);
	// Load the module from the Vite SSR Runtime.
	const mod = (await viteServer.ssrLoadModule(fileURLToPath(filePath))) as ComponentInstance;

	return [renderers, renderHooks, mod];
}

/** use Vite to SSR */
export async function render(
	renderers: SSRLoadedRenderer[],
	renderHooks: SSRLoadedRenderHook[],
	mod: ComponentInstance,
	ssrOpts: SSROptions
): Promise<RenderResponse> {
	const {
		astroConfig,
		filePath,
		logging,
		mode,
		origin,
		pathname,
		request,
		route,
		routeCache,
		viteServer,
	} = ssrOpts;
	// TODO: clean up "legacy" flag passed through helper functions
	const isLegacyBuild = false;

	// Add hoisted script tags
	const scripts = createModuleScriptElementWithSrcSet(
		!isLegacyBuild && mod.hasOwnProperty('$$metadata')
			? Array.from(mod.$$metadata.hoistedScriptPaths())
			: []
	);

	// Inject HMR scripts
	if (mod.hasOwnProperty('$$metadata') && mode === 'development' && !isLegacyBuild) {
		scripts.add({
			props: { type: 'module', src: '/@vite/client' },
			children: '',
		});
		scripts.add({
			props: {
				type: 'module',
				src: new URL('../../../runtime/client/hmr.js', import.meta.url).pathname,
			},
			children: '',
		});
	}
	// TODO: We should allow adding generic HTML elements to the head, not just scripts
	for (const script of astroConfig._ctx.scripts) {
		if (script.stage === 'head-inline') {
			scripts.add({
				props: {},
				children: script.content,
			});
		}
	}

	// Pass framework CSS in as link tags to be appended to the page.
	let links = new Set<SSRElement>();
	if (!isLegacyBuild) {
		[...getStylesForURL(filePath, viteServer)].forEach((href) => {
			if (mode === 'development' && svelteStylesRE.test(href)) {
				scripts.add({
					props: { type: 'module', src: href },
					children: '',
				});
			} else {
				links.add({
					props: {
						rel: 'stylesheet',
						href,
						'data-astro-injected': true,
					},
					children: '',
				});
			}
		});
	}

	let content = await coreRender({
		// TODO: Remove this flag once legacyBuild support is removed
		legacyBuild: isLegacyBuild,
		links,
		logging,
		markdownRender: [astroRemark, astroConfig.markdown],
		mod,
		origin,
		pathname,
		scripts,
		// Resolves specifiers in the inline hydrated scripts, such as "@astrojs/preact/client.js"
		// TODO: Can we pass the hydration code more directly through Vite, so that we
		// don't need to copy-paste and maintain Vite's import resolution here?
		async resolve(s: string) {
			const [resolvedUrl, resolvedPath] = await viteServer.moduleGraph.resolveUrl(s);
			if (resolvedPath.includes('node_modules/.vite')) {
				return resolvedPath.replace(/.*?node_modules\/\.vite/, '/node_modules/.vite');
			}
			// NOTE: This matches the same logic that Vite uses to add the `/@id/` prefix.
			if (!resolvedUrl.startsWith('.') && !resolvedUrl.startsWith('/')) {
				return '/@id' + prependForwardSlash(resolvedUrl);
			}
			return '/@fs' + prependForwardSlash(resolvedPath);
		},
		renderers,
		renderHooks,
		request,
		route,
		routeCache,
		site: astroConfig.site ? new URL(astroConfig.base, astroConfig.site).toString() : undefined,
		ssr: isBuildingToSSR(astroConfig),
	});

	if (route?.type === 'endpoint' || content.type === 'response') {
		return content;
	}

	// inject tags
	const tags: vite.HtmlTagDescriptor[] = [];

	// dev only: inject Astro HMR client
	if (mode === 'development' && isLegacyBuild) {
		tags.push({
			tag: 'script',
			attrs: { type: 'module' },
			// HACK: inject the direct contents of our `astro/runtime/client/hmr.js` to ensure
			// `import.meta.hot` is properly handled by Vite
			children: await getHmrScript(),
			injectTo: 'head',
		});
	}

	// inject CSS
	if (isLegacyBuild) {
		[...getStylesForURL(filePath, viteServer)].forEach((href) => {
			if (mode === 'development' && svelteStylesRE.test(href)) {
				tags.push({
					tag: 'script',
					attrs: { type: 'module', src: href },
					injectTo: 'head',
				});
			} else {
				tags.push({
					tag: 'link',
					attrs: {
						rel: 'stylesheet',
						href,
						'data-astro-injected': true,
					},
					injectTo: 'head',
				});
			}
		});
	}

	// add injected tags
	let html = injectTags(content.html, tags);

	// inject <!doctype html> if missing (TODO: is a more robust check needed for comments, etc.?)
	if (!/<!doctype html/i.test(html)) {
		html = '<!DOCTYPE html>\n' + content;
	}

	return {
		type: 'html',
		html,
	};
}

export async function ssr(
	preloadedComponent: ComponentPreload,
	ssrOpts: SSROptions
): Promise<RenderResponse> {
	const [renderers, renderHooks, mod] = preloadedComponent;
	return await render(renderers, renderHooks, mod, ssrOpts); // NOTE: without "await", errors won’t get caught below
}
