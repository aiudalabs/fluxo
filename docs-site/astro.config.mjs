// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';

// Documentación oficial de Fluxo (Astro Starlight → salida estática, se sirve con Caddy).
// El contenido vive en src/content/docs/. El sidebar de abajo es la navegación.
// - astro-mermaid: renderiza los bloques ```mermaid (client-side, cambia light/dark con el theme del
//   sitio). VA PRIMERO en integrations (lo pide el paquete para engancharse antes que Starlight).
// - customCss (styles/fluxo.css): el theme de marca Fluxo (accent #ec4a12, fuentes Space Grotesk +
//   Inter) sobre el default de Starlight, para coherencia con el console.
export default defineConfig({
	site: 'https://docs.fluxo.aiudalabs.com',
	integrations: [
		mermaid({ theme: 'default', autoTheme: true }),
		starlight({
			title: 'Fluxo · Docs',
			description: 'La fábrica de software gobernada — método, workflows, agentes, arquitectura e instalación.',
			defaultLocale: 'es',
			locales: { root: { label: 'Español', lang: 'es' } },
			customCss: ['./src/styles/fluxo.css'],
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
					label: 'Arquitectura',
					items: [
						{ label: 'Vista general', slug: 'arquitectura/vista-general' },
						{ label: 'Secuencia end-to-end', slug: 'arquitectura/secuencia-e2e' },
						{ label: 'Despliegue', slug: 'arquitectura/despliegue' },
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
