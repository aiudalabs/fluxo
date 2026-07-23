// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Documentación oficial de Fluxo (Astro Starlight → salida estática, se sirve con Caddy).
// El contenido vive en src/content/docs/. El sidebar de abajo es la navegación.
export default defineConfig({
	site: 'https://docs.fluxo.aiudalabs.com',
	integrations: [
		starlight({
			title: 'Fluxo · Docs',
			description: 'La fábrica de software gobernada — método, workflows, agentes e instalación.',
			defaultLocale: 'es',
			locales: { root: { label: 'Español', lang: 'es' } },
			social: [{ icon: 'external', label: 'AIuda Labs', href: 'https://fluxo.aiudalabs.com' }],
			sidebar: [
				{ label: 'Introducción', slug: 'index' },
				{
					label: 'El método',
					items: [
						{ label: 'Workflows y agentes', slug: 'metodo/workflows-y-agentes' },
						{ label: 'Extender el método', slug: 'metodo/extender-el-metodo' },
					],
				},
				{
					label: 'Instalación',
					items: [
						{ label: 'Cloud (fluxo.aiudalabs.com)', slug: 'instalacion/cloud' },
						{ label: 'On-premise (self-host)', slug: 'instalacion/on-premise' },
					],
				},
			],
		}),
	],
});
