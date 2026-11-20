if (typeof window !== 'undefined') {
	(window as unknown as { __loremLog: (...args: unknown[]) => void }).__loremLog = (
		...args: unknown[]
	) => {
		// eslint-disable-next-line no-console
		console.log('[lorem]', ...args);
	};
}
