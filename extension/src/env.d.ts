/** Compile-time flag injected by esbuild (`--dev` build enables test hooks). */
declare const __DEV__: boolean;

declare module '*.css' {
  const text: string;
  export default text;
}
