/**
 * Greeting utility function for testing context-assisted pipeline.
 */

/**
 * Returns a greeting message for the given name.
 * @param name - The name to greet. If empty, defaults to "World".
 * @returns A greeting string in the format "Hello, {name}!"
 */
export function greet(name: string): string {
  const targetName = name.trim() === "" ? "World" : name;
  return `Hello, ${targetName}!`;
}
