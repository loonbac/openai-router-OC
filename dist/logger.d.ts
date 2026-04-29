export declare function logInfo(message: string): void;
export declare function logWarn(message: string): void;
export declare function logError(message: string): void;
export declare function getLogPath(): string;
export declare function readLogTail(maxLines?: number): string[];
/**
 * Write a log message to /tmp/openai-router.log.
 * Silently ignores write failures.
 */
export declare function log(message: string): void;
/**
 * Write an error message to /tmp/openai-router.log.
 * Silently ignores write failures.
 */
export declare function error(message: string): void;
//# sourceMappingURL=logger.d.ts.map