export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface RunStats {
	tokensPerSecond: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	elapsedTime: string;
	idleTime: string;
	time: string;
}

export interface SessionUsage {
	totals: UsageTotals;
	latestCacheHitRate: number | undefined;
}
