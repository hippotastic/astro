import { RouteType, SSRLoadedRenderHook } from "../@types/astro";

export async function runRenderHookPostProcessHtml({
	renderHooks,
	routeType,
	pathname,
	html,
	ssr,
} :{
	renderHooks: SSRLoadedRenderHook[];
	routeType: RouteType;
	pathname: string;
	html: string;
	ssr: boolean;
}) {
	for (let i = 0; i < renderHooks.length; i++) {
		let postProcessHtml = renderHooks[i].ssr.postProcessHtml;
		if (!postProcessHtml)
			continue;
		
		let newHtml = await renderHooks[i].ssr.postProcessHtml({
			routeType,
			pathname,
			html,
			ssr,
			options: renderHooks[i].options,
		});
		if (newHtml)
			html = newHtml;
	}

	return html;
}
