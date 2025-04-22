import * as core from '@actions/core';
import { getInput, getBooleanInput } from '@actions/core';
import Dockerode from 'dockerode';
import { exec } from '@actions/exec';
import { dump, load } from 'js-yaml';
import * as crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { access, constants, readFile, writeFile, unlink } from 'node:fs/promises';
import { debug } from 'node:util';
import { join } from 'path';
import { createHash } from 'crypto';
import { env } from 'node:process';

const version = "0.0.1";
const packageJson = {
	version: version};

async function exists(path) {
  try {
    await access(path, constants.F_OK);
  } catch {
    return false;
  }
  return true;
}
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const nameLabel = "com.matchory.deployment.name";
const hashLabel = "com.matchory.deployment.hash";
const stackLabel = "com.matchory.deployment.stack";
const versionLabel = "com.matchory.deployment.version";
const encodeLabel = "com.matchory.deployment.encode";
const decodeLabel = "com.matchory.deployment.decode";
const ignoreLabel = "com.matchory.deployment.ignore";
async function processVariable(name, variable, {
  envVarPrefix,
  stack,
  version
}) {
  core.debug(`Processing variable ${name}`);
  if (variable?.labels?.[ignoreLabel] === "true") {
    core.debug(`Variable "${name}" is marked as ignored. Skipping.`);
    return variable;
  }
  if (variable == null) {
    variable = {};
  }
  let modifiedVariable = void 0;
  let content;
  if ("file" in variable) {
    content = await readFromFile(name, variable);
  } else if ("environment" in variable) {
    content = readFromEnvironment(name, variable);
    modifiedVariable = await transformVariable(content, name, variable);
  } else if ("content" in variable) {
    content = readFromContent(name, variable);
    modifiedVariable = await transformVariable(content, name, variable);
  } else {
    [content, modifiedVariable] = await inferVariable(name, variable, {
      envVarPrefix,
      stack
    });
  }
  if (!content) {
    core.warning(
      `Variable "${name}" is defined with an empty value. This is not recommended, as it may lead to unexpected behavior.`
    );
  }
  if (variable.labels && encodeLabel in variable.labels) {
    content = await encodeVariable(content, name, variable);
    modifiedVariable = await transformVariable(content, name, variable);
  } else if (variable.labels && decodeLabel in variable.labels) {
    content = await decodeVariable(content, name, variable);
    modifiedVariable = await transformVariable(content, name, variable);
  }
  const hash = hashVariable(content);
  const variableName = modifiedVariable?.name ?? variable.name ?? `${stack}-${name}`;
  return {
    ...modifiedVariable ?? variable,
    name: `${variableName}-${hash.substring(0, 7)}`,
    labels: {
      ...modifiedVariable?.labels ?? variable.labels,
      [nameLabel]: name,
      [hashLabel]: hash,
      [stackLabel]: stack,
      [versionLabel]: version
    }
  };
}
async function readFromFile(name, variable) {
  const filePath = variable.file;
  if (!await exists(filePath)) {
    throw new Error(
      `Variable "${name}" specifies the file "${filePath}" as its source, but this file does not exist or is not readable. Ensure it exists, or remove the "file" property from the variable definition to let the action read the value from the build environment automatically.`
    );
  }
  core.debug(`Loading variable ${name} from file: ${filePath}`);
  return await readFile(filePath, "utf8");
}
function readFromEnvironment(name, { environment: variable }) {
  if (!(variable in env) || env[variable] === void 0) {
    throw new Error(
      `Variable "${name}" specifies the environment variable "${variable}" as its source, but there is no such variable defined in the environment. Ensure it exists, or remove the "environment" property from the variable definition to let the action infer the value from the variable name automatically.`
    );
  }
  return String(env[variable]);
}
function readFromContent(_name, { content }) {
  return String(content);
}
async function inferVariable(name, variable, { envVarPrefix, stack }) {
  const filePath = `./${name}.secret`;
  if (await exists(filePath)) {
    core.debug(`Loading variable "${name}" from file: "${filePath}"`);
    return [
      await readFile(filePath, "utf8"),
      { ...variable, file: filePath }
    ];
  }
  const safeName = name.replace(/-/g, "_");
  const variantUpper = safeName.toUpperCase();
  for (const variant of [
    safeName,
    variantUpper,
    `${envVarPrefix}_${safeName}`,
    `${envVarPrefix}_${variantUpper}`,
    `${stack}_${safeName}`,
    `${stack}_${safeName}`.toUpperCase()
  ]) {
    if (env[variant]) {
      core.debug(
        `Loading variable "${name}" from environment variable "${variant}"`
      );
      variable.environment = variant;
      return [
        env[variant],
        await transformVariable(env[variant], name, variable)
      ];
    }
  }
  throw new Error(
    `Variable "${name}" is not defined in the environment. To use it as a secret or config, please set the environment variable "${variantUpper}" or "${envVarPrefix}_${variantUpper}", or create a file named "${name}.secret" in the project root directory.`
  );
}
const encoders = {
  base64: (value) => Buffer.from(value, "utf8").toString("base64"),
  base64url: (value) => Buffer.from(value, "utf8").toString("base64url"),
  hex: (value) => Buffer.from(value, "utf8").toString("hex"),
  url: (value) => encodeURIComponent(value)
};
const decoders = {
  base64: (value) => Buffer.from(value, "base64").toString("utf8"),
  base64url: (value) => Buffer.from(value, "base64url").toString("utf8"),
  hex: (value) => Buffer.from(value, "hex").toString("utf8"),
  url: (value) => decodeURIComponent(value)
};
async function encodeVariable(content, name, variable) {
  const format = variable.labels[encodeLabel].toString();
  if (!encoders[format]) {
    const supported = Object.keys(encoders).join(", ");
    throw new Error(
      `Variable "${name}" specifies an unknown encoding format: "${format}". Must be one of "${supported}".`
    );
  }
  core.debug(`Encoding variable "${name}" to ${format}`);
  return encoders[format](content);
}
async function decodeVariable(content, name, variable) {
  const format = variable.labels[decodeLabel].toString();
  if (!decoders[format]) {
    const supported = Object.keys(decoders).join(", ");
    throw new Error(
      `Variable "${name}" specifies an unknown decoding format: "${format}". Must be one of "${supported}".`
    );
  }
  core.debug(`Decoding variable "${name}" from ${format}`);
  return decoders[format](content);
}
async function transformVariable(value, name, variable) {
  const path = `./${name}.${crypto.randomUUID()}.generated.secret`;
  await writeFile(path, value, "utf8");
  delete variable.environment;
  delete variable.content;
  return {
    ...variable,
    file: path,
    labels: {
      ...variable.labels
    }
  };
}
async function pruneVariables(composeSpec, client, settings) {
  core.startGroup("Pruning outdated variables");
  await pruneSecrets(composeSpec, client, settings);
  await pruneConfigs(composeSpec, client, settings);
  core.endGroup();
}
async function pruneSecrets({ secrets }, client, { stack }) {
  core.debug(`Pruning secrets for stack "${stack}"`);
  const variableIdentifier = ({
    stack: stack2,
    name,
    hash
  }) => stack2 + name + hash;
  const specSecrets = secrets ? Object.values(secrets).map(({ labels }) => marshalLabels(labels)).filter((labels) => labels !== void 0).map((labels) => variableIdentifier(labels)) : [];
  const items = await client.listSecrets({
    filters: { label: [`${stackLabel}=${stack}`] }
  });
  if (items.length == 0) {
    return;
  }
  core.info(
    `Checking ${items.length} secret${items.length !== 1 ? "s" : ""} for stack "${stack}"`
  );
  for (let i = 0; i < items.length; i++) {
    const { CreatedAt, ID, Spec } = items[i];
    if (!Spec) {
      core.warning(`Found invalid secret "${ID}": No spec found. Ignoring.`);
      continue;
    }
    const name = Spec.Name ?? ID;
    const labels = marshalLabels(Spec.Labels);
    core.debug(`Checking secret ${i + 1}/${items.length}: ${name}`);
    if (!labels) {
      core.warning(`Found invalid secret "${name}": Missing labels. Pruning.`);
      await client.getSecret(ID).remove();
      continue;
    }
    if (!specSecrets.includes(variableIdentifier(labels))) {
      const hash = labels.hash.substring(0, 7);
      core.debug(
        `Pruning outdated version "${hash}" of secret "${labels.name}": ${name}`
      );
      await client.getSecret(ID).remove();
    }
    if (shouldRotate(new Date(CreatedAt ?? 0))) {
      core.warning(
        `Secret "${name}" has been in use for too long and should be rotated!`
      );
    }
  }
}
async function pruneConfigs({ configs }, client, { stack }) {
  core.debug(`Pruning configs for stack "${stack}"`);
  const variableIdentifier = ({
    stack: stack2,
    name,
    hash
  }) => stack2 + name + hash;
  const specConfigs = configs ? Object.values(configs).map(({ labels }) => marshalLabels(labels)).filter((labels) => labels !== void 0).map((labels) => variableIdentifier(labels)) : [];
  const items = await client.listConfigs({
    filters: { label: [`${stackLabel}=${stack}`] }
  });
  if (items.length == 0) {
    return;
  }
  core.info(
    `Checking ${items.length} config${items.length !== 1 ? "s" : ""} for stack "${stack}"`
  );
  for (let i = 0; i < items.length; i++) {
    const { ID, Spec } = items[i];
    if (!Spec) {
      core.warning(`Found invalid config "${ID}": No spec found. Ignoring.`);
      continue;
    }
    const name = Spec.Name ?? ID;
    const labels = marshalLabels(Spec.Labels);
    core.debug(`Checking config ${i + 1}/${items.length}: ${name}`);
    if (!labels) {
      core.warning(
        `Found invalid config "${name}": Missing variable labels. Pruning.`
      );
      await client.getConfig(ID).remove();
      continue;
    }
    if (!specConfigs.includes(variableIdentifier(labels))) {
      const hash = labels.hash.substring(0, 7);
      core.debug(
        `Pruning outdated version "${hash}" of config "${labels.name}": ${name}`
      );
      await client.getConfig(ID).remove();
    }
  }
}
function hashVariable(value) {
  return createHash("sha256").update(value.trim()).digest("hex");
}
function marshalLabels(labels) {
  const name = labels?.[nameLabel];
  const hash = labels?.[hashLabel];
  const stack = labels?.[stackLabel];
  const version = labels?.[versionLabel];
  if (!name || !hash || !stack || !version) {
    return void 0;
  }
  return {
    name: String(name),
    hash: String(hash),
    stack: String(stack),
    version: String(version)
  };
}
function shouldRotate(createdAt) {
  const thirtyDaysAgo = /* @__PURE__ */ new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  return createdAt < thirtyDaysAgo;
}

const schemaVersion = "3.9";
const defaultVariants = [
  "docker-compose.production.yaml",
  "docker-compose.production.yml",
  "docker-compose.prod.yaml",
  "docker-compose.prod.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
  join(".docker", "docker-compose.yaml"),
  join(".docker", "docker-compose.yml"),
  join("docker", "docker-compose.yaml"),
  join("docker", "docker-compose.yml")
];
async function resolveComposeFiles(settings) {
  debug(`Resolving compose file from ${settings.composeFiles}`);
  if (settings.composeFiles && settings.composeFiles.length > 0) {
    const files = await Promise.all(
      settings.composeFiles.map((path) => exists(path))
    );
    if (!files.every(Boolean)) {
      const missing = files.map(
        (exists2, index) => !exists2 ? settings.composeFiles?.[index] : void 0
      ).filter((file) => file !== void 0);
      throw new Error(
        `One or more Compose Files specified in the configuration are missing or not readable: ${missing.join(", ")}`
      );
    }
    return settings.composeFiles;
  }
  for (const location of defaultVariants) {
    if (await exists(location)) {
      core.info(`Found compose file at "${location}"`);
      return [location];
    }
  }
  throw new Error("Could not find suitable compose file");
}
async function loadComposeSpecs(composeFiles, settings) {
  return Promise.all(
    composeFiles.map((path) => loadComposeSpec(path, settings))
  );
}
async function loadComposeSpec(filename, settings) {
  const content = await readFile(filename, "utf8");
  const parsedContent = load(content, { filename });
  return reconcileSpec(parsedContent, settings);
}
async function reconcileSpec(composeSpec, settings) {
  if (composeSpec.name) {
    delete composeSpec.name;
  }
  if (!composeSpec.version) {
    composeSpec.version = schemaVersion;
  }
  if (!composeSpec.services || Object.keys(composeSpec.services).length === 0) {
    throw new Error("Invalid stack specification: Missing services section");
  }
  if (composeSpec.secrets) {
    for (const [name, entry] of Object.entries(composeSpec.secrets)) {
      composeSpec.secrets[name] = await processVariable(name, entry, settings);
    }
  }
  if (composeSpec.configs) {
    for (const [name, entry] of Object.entries(composeSpec.configs)) {
      composeSpec.configs[name] = await processVariable(name, entry, settings);
    }
  }
  return composeSpec;
}
async function normalizeComposeSpec(composeSpecs, _settings) {
  const composeFiles = await Promise.all(
    composeSpecs.map(async (spec2) => {
      const file = `docker-compose.generated.${randomUUID()}.yaml`;
      await writeFile(file, dump(spec2));
      return file;
    })
  );
  let content = "";
  const exitCode = await exec(
    "docker",
    [
      "stack",
      "config",
      ...composeFiles.map((path) => `--compose-file=${path}`)
    ],
    {
      listeners: {
        stdout: (data) => content += data.toString()
      }
    }
  );
  await Promise.all(composeFiles.map((path) => unlink(path)));
  if (exitCode > 0) {
    throw new Error(
      `Failed to load compose file(s): Docker command failed with exit code [${exitCode}]. Check the logs for more details.`
    );
  }
  if (!content) {
    throw new Error(
      "Failed to load compose file(s): No content produced. This is most likely a bug in the deployment action. Please report it to the action issues."
    );
  }
  const spec = load(`${content}
`, {
    filename: "docker-compose.yaml",
    onWarning: (error) => core.warning(error)
  });
  if (!spec) {
    throw new Error(
      "Failed to load compose file(s): Failed to parse YAML output. This is most likely a bug in the deployment action. Please report it to the action issues."
    );
  }
  if (!spec?.services || Object.keys(spec.services).length === 0) {
    throw new Error("Invalid stack specification: Missing services section");
  }
  return spec;
}
async function deployStack(spec, settings) {
  core.startGroup("Deploying stack");
  try {
    await exec(
      "docker",
      [
        "stack",
        "deploy",
        "--prune",
        "--quiet",
        "--with-registry-auth",
        "--resolve-image",
        "always",
        "--compose-file",
        "-",
        settings.stack
      ],
      { input: Buffer.from(dump(spec)) }
    );
    core.info(`Deployed stack ${settings.stack}`);
    core.endGroup();
  } catch (error) {
    core.endGroup();
    throw error;
  }
}

async function monitorDeployment(client, settings) {
  if (!settings.monitor) {
    core.info("Post-Deployment monitoring is disabled");
    return;
  }
  core.startGroup("Monitoring deployment rollout");
  core.info(`Monitoring stack "${settings.stack}" for post-deployment issues`);
  const startTime = /* @__PURE__ */ new Date();
  let attemptsLeft = Math.ceil(
    settings.monitorTimeout / settings.monitorInterval
  );
  const completedServices = /* @__PURE__ */ new Set();
  let services;
  do {
    if (--attemptsLeft <= 0) {
      throw new Error("Deployment timed out");
    }
    services = await loadServices(client, settings);
    core.debug(
      `Waiting for services to complete: ${completedServices.size}/${services.length}`
    );
    for (const service of services) {
      if (completedServices.has(service.ID)) {
        continue;
      }
      let complete;
      try {
        complete = isServiceUpdateComplete(service);
      } catch (error) {
        if (!(error instanceof Error)) {
          core.error(
            "An unexpected error occurred while checking the servicestatus. This is likely a bug in the deployment action. Please report this issue in the repository."
          );
          throw error;
        }
        const logs = await client.getService(service.ID).logs({
          stdout: true,
          stderr: true,
          timestamps: true,
          details: true,
          since: startTime.getTime() / 1e3
        });
        core.error(
          `Service "${service.Spec?.Name ?? service.ID}" failed to update: ${error.message}`
        );
        core.error(`Service logs since deployment:
${logs.toString()}`);
        throw error;
      }
      if (complete) {
        core.info(
          `Service "${service.Spec?.Name}" has been deployed successfully`
        );
        completedServices.add(service.ID);
      }
    }
    if (completedServices.size < services.length) {
      await sleep(settings.monitorInterval * 1e3);
    }
  } while (completedServices.size < services.length);
  core.info("All services have been deployed successfully");
}
function loadServices(client, settings) {
  return client.listServices({
    filters: {
      label: [`com.docker.stack.namespace=${settings.stack}`]
    },
    status: true
  });
}
function isServiceUpdateComplete(service) {
  const name = service.Spec?.Name ?? service.ID;
  core.debug(`Checking update status of service ${name}`);
  if (!service.UpdateStatus) {
    if (isServiceRunning(service)) {
      return true;
    }
    core.debug(`Update of service ${name} is still in progress`);
    return false;
  }
  const updateStatus = service.UpdateStatus.State ?? "unknown";
  if (updateStatus === "completed") {
    core.debug(`Update of service "${name}" is complete`);
    return true;
  }
  if (updateStatus === "updating") {
    core.debug(`Update of service "${name}" is still in progress`);
    return false;
  }
  const reason = resolveFailureReason(updateStatus);
  throw new Error(`Update of service "${name}" failed: ${reason}`);
}
function isServiceRunning(service) {
  const name = service.Spec?.Name ?? service.ID;
  core.debug(`Checking if service "${name}" is currently running`);
  if (service.ServiceStatus) {
    const running = service.ServiceStatus.RunningTasks ?? 0;
    const desired = service.ServiceStatus.DesiredTasks ?? 0;
    if (running === desired) {
      core.debug(`Service "${name}" is running`);
      return true;
    }
    core.debug(
      `Service "${name}" is only partially running: ${running}/${desired} tasks running`
    );
    return false;
  }
  core.debug(`Service "${name}" is not running`);
  return false;
}
function resolveFailureReason(state) {
  return {
    paused: "Service is paused",
    rollback_started: "Service failed to update and is being rolled back",
    rollback_completed: "Service failed to update and was rolled back",
    rollback_paused: "Service is paused and is being rolled back",
    unknown: "Service update status is unknown"
  }[state] ?? "Unknown failure reason";
}

function createClient(_settings) {
  const { version } = packageJson;
  return new Dockerode({
    headers: {
      "user-agent": `matchory-deployment/${version} (github-action)`
    }
  });
}
async function deploy(settings) {
  const client = createClient();
  const composeFiles = await resolveComposeFiles(settings);
  const composeSpecs = await loadComposeSpecs(composeFiles, settings);
  const composeSpec = await normalizeComposeSpec(composeSpecs);
  await deployStack(composeSpec, settings);
  if (settings.monitor) {
    await monitorDeployment(client, settings);
  }
  await pruneVariables(composeSpec, client, settings);
  return composeSpec;
}

function defineSettings(settings) {
  return settings;
}
function parseSettings() {
  debug("Parsing settings from inputs");
  return defineSettings({
    stack: inferStackName(getInput("stack-name")),
    version: inferVersion(getInput("version")),
    composeFiles: inferComposeFiles(getInput("compose-file")),
    envVarPrefix: (getInput("env-var-prefix") || "DEPLOYMENT").replace(
      /_$/,
      ""
    ),
    monitor: getBooleanInput("monitor", { required: false }) ?? false,
    monitorTimeout: parseInt(getInput("monitor-timeout") || "300", 10),
    monitorInterval: parseInt(getInput("monitor-interval") || "5", 10)
  });
}
function inferStackName(name) {
  return name || env.GITHUB_REPOSITORY?.split("/")?.pop() || "unknown";
}
function inferVersion(version) {
  if (version) {
    return version;
  }
  if (env.GITHUB_REF?.startsWith("refs/tags/")) {
    return env.GITHUB_REF.replace("refs/tags/", "");
  }
  return env.GITHUB_SHA?.substring(0, 7) ?? "unknown";
}
function inferComposeFiles(files) {
  const composeFiles = files ?? env.COMPOSE_FILE;
  const separator = env.COMPOSE_PATH_SEPARATOR || ":";
  return (composeFiles?.split(separator) ?? []).map((file) => file.trim()).filter(Boolean);
}

async function run() {
  const settings = parseSettings();
  try {
    const composeSpec = await deploy(settings);
    core.setOutput("compose-spec", composeSpec);
    core.setOutput("stack-name", settings.stack);
    core.setOutput("version", settings.version);
    core.setOutput("status", "success");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error);
    } else {
      core.setFailed("An unknown error occurred");
    }
    core.setOutput("status", "failure");
  }
}

export { run };
//# sourceMappingURL=main.mjs.map
