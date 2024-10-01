export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const { hostname, pathname, search } = url;

		let destinationHost: string = 'bar.com';
		let destinationPath: string = '/';
		const statusCode = 301;

		switch (hostname) {
			case 'foo.bar.com':
				destinationPath = '/foo';
				break;
		}

		const destinationURL = `https://${destinationHost}${destinationPath}${pathname}${search}`;
		return Response.redirect(destinationURL, statusCode);
	},
} satisfies ExportedHandler;
