export function loadConfig() {
    delete require.cache[require.resolve("./config.js")];
    return require("./config.js");
}