'use strict';

// Discord bot for simplecloud.
//
// Lets allowed users browse cloud storage and store files by dropping an
// attachment in a watched channel. Runs in-process with the Fastify server
// and talks to storage/db directly (no HTTP hop).
//
// Files sent to the bot are saved under the logical prefix `discord_files/`,
// so they appear in the manifest and sync to every client like any other file.

const https = require('https');
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
  EmbedBuilder,
} = require('discord.js');

const fs = require('fs');
const { getAllFiles, getFile } = require('../db');
const { getReadStream } = require('../storage');
const { storeBuffer } = require('../fileService');
const lockService = require('../lockService');
const { discord: discordConfig, lockedFolderName, storageDir } = require('../config');

const DISCORD_PREFIX = 'discord_files';

// ── helpers ───────────────────────────────────────────────────────────────────

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// Sanitize an attachment filename into a safe relative path segment.
function safeName(name) {
  return name
    .replace(/[\\/]+/g, '_')        // no path separators
    .replace(/\.{2,}/g, '.')        // no `..` traversal
    .replace(/[^\w.\- ]+/g, '_')    // keep it conservative
    .trim() || 'file';
}

// Download a Discord attachment URL into a Buffer (capped at maxBytes).
function fetchAttachment(url, maxBytes) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Attachment download failed: HTTP ${res.statusCode}`));
        }
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            return reject(new Error('Attachment exceeds size limit'));
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

// ── slash command definitions ──────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('list')
    .setDescription('List the contents of one directory (default: root)')
    .addStringOption((o) =>
      o.setName('dir').setDescription('Directory to list, e.g. "docs/" (default: root)').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('tree')
    .setDescription('Show a folder-style tree of cloud storage')
    .addStringOption((o) =>
      o.setName('prefix').setDescription('Subtree to show').setRequired(false)
    )
    .addIntegerOption((o) =>
      o
        .setName('depth')
        .setDescription('How many folder levels to expand (default 2). Use a larger value to dig deeper.')
        .setMinValue(1)
        .setMaxValue(20)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search full file paths in cloud storage')
    .addStringOption((o) =>
      o.setName('query').setDescription('Substring to match anywhere in the path').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('find')
    .setDescription('Find files by name (matches the filename only, not the folder)')
    .addStringOption((o) =>
      o.setName('name').setDescription('Filename text to match, e.g. "report" or ".pdf"').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('get')
    .setDescription('Download a file from cloud storage')
    .addStringOption((o) =>
      o.setName('path').setDescription('Full path of the file (see /list)').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show whether the secure folder is locked or unlocked'),
].map((c) => c.toJSON());

// ── access control ──────────────────────────────────────────────────────────────

function isAllowed(interactionOrMessage) {
  const { allowedUserIds = [], allowedChannelIds = [] } = discordConfig;

  const userId =
    interactionOrMessage.user?.id || interactionOrMessage.author?.id || null;
  const channelId = interactionOrMessage.channelId || interactionOrMessage.channel?.id || null;

  // If both allowlists are empty, deny by default (fail closed).
  if (allowedUserIds.length === 0 && allowedChannelIds.length === 0) return false;

  const userOk = allowedUserIds.length === 0 || (userId && allowedUserIds.includes(userId));
  const channelOk =
    allowedChannelIds.length === 0 || (channelId && allowedChannelIds.includes(channelId));

  return userOk && channelOk;
}

// ── command handlers ─────────────────────────────────────────────────────────────

function paginate(lines, header) {
  // Discord messages cap at 2000 chars. Chunk lines into safe blocks.
  const blocks = [];
  let current = header ? `${header}\n` : '';
  for (const line of lines) {
    if (current.length + line.length + 1 > 1900) {
      blocks.push(current);
      current = '';
    }
    current += line + '\n';
  }
  if (current.trim()) blocks.push(current);
  return blocks.length ? blocks : ['_(empty)_'];
}

// Normalize a user-supplied directory into a "" (root) or "dir/sub/" prefix.
function normalizeDir(dir) {
  let d = (dir || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (d && !d.endsWith('/')) d += '/';
  return d;
}

async function handleList(interaction) {
  const dir = normalizeDir(interaction.options.getString('dir'));
  const all = getAllFiles();

  // Immediate children of `dir` only — not the whole subtree. A path with a
  // further "/" after the prefix is inside a subfolder, which we show once with
  // a count instead of listing recursively.
  const fileEntries = [];          // files directly in this dir
  const subdirCounts = new Map();  // subfolder name → number of files beneath it

  for (const f of all) {
    if (dir && !f.path.startsWith(dir)) continue;
    const rel = dir ? f.path.slice(dir.length) : f.path;
    if (!rel) continue;
    const slash = rel.indexOf('/');
    if (slash === -1) {
      fileEntries.push(f); // a file directly in this directory
    } else {
      const sub = rel.slice(0, slash);
      subdirCounts.set(sub, (subdirCounts.get(sub) || 0) + 1);
    }
  }

  if (fileEntries.length === 0 && subdirCounts.size === 0) {
    return interaction.editReply(dir ? `\`${dir}\` is empty or does not exist.` : 'Storage is empty.');
  }

  const lines = [];
  // Folders first (sorted), then files (sorted).
  for (const name of [...subdirCounts.keys()].sort((a, b) => a.localeCompare(b))) {
    const n = subdirCounts.get(name);
    lines.push(`📁 \`${name}/\` — ${n} file${n === 1 ? '' : 's'}`);
  }
  for (const f of fileEntries.sort((a, b) => a.path.localeCompare(b.path))) {
    const name = f.path.slice(dir.length);
    lines.push(`📄 \`${name}\` — ${humanSize(f.size)}`);
  }

  const header = `**${dir ? `\`${dir}\`` : 'root'}** — ${subdirCounts.size} folder${
    subdirCounts.size === 1 ? '' : 's'
  }, ${fileEntries.length} file${fileEntries.length === 1 ? '' : 's'}:`;
  const blocks = paginate(lines, header);

  await interaction.editReply(blocks[0]);
  for (const block of blocks.slice(1)) await interaction.followUp({ content: block, ephemeral: true });
}

// Default number of folder levels to expand. Deeper folders are collapsed into
// a "(N items)" summary so a big tree doesn't blow up the message.
const DEFAULT_TREE_DEPTH = 2;

async function handleTree(interaction) {
  const prefix = interaction.options.getString('prefix') || '';
  const maxDepth = interaction.options.getInteger('depth') || DEFAULT_TREE_DEPTH;
  const files = getAllFiles()
    .filter((f) => f.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (files.length === 0) {
    return interaction.editReply(prefix ? `No files under \`${prefix}\`.` : 'Storage is empty.');
  }

  // Build a nested structure from the path segments.
  const root = {};
  for (const f of files) {
    const rel = prefix ? f.path.slice(prefix.length).replace(/^\//, '') : f.path;
    const parts = rel.split('/');
    let node = root;
    parts.forEach((part, idx) => {
      const isFile = idx === parts.length - 1;
      if (isFile) {
        node[part] = { __file: true, size: f.size };
      } else {
        node[part] = node[part] || {};
        node = node[part];
      }
    });
  }

  // Count every file under a folder node (recursively), for the collapsed summary.
  const countFiles = (node) => {
    let n = 0;
    for (const key of Object.keys(node)) {
      if (node[key].__file) n += 1;
      else n += countFiles(node[key]);
    }
    return n;
  };

  const lines = [];
  let collapsed = 0; // how many folders we collapsed at the depth limit
  const render = (node, depth) => {
    const keys = Object.keys(node).sort((a, b) => {
      const aFile = node[a].__file ? 1 : 0;
      const bFile = node[b].__file ? 1 : 0;
      return aFile - bFile || a.localeCompare(b);
    });
    for (const key of keys) {
      const indent = '  '.repeat(depth);
      if (node[key].__file) {
        lines.push(`${indent}📄 ${key} (${humanSize(node[key].size)})`);
      } else if (depth + 1 >= maxDepth) {
        // At the depth limit — collapse this folder into a file-count summary
        // instead of expanding its contents.
        const n = countFiles(node[key]);
        lines.push(`${indent}📁 ${key}/ … (${n} item${n === 1 ? '' : 's'})`);
        collapsed += 1;
      } else {
        lines.push(`${indent}📁 ${key}/`);
        render(node[key], depth + 1);
      }
    }
  };
  render(root, 0);

  const header = `**Tree${prefix ? ` of \`${prefix}\`` : ''}** (depth ${maxDepth})${
    collapsed ? ` — ${collapsed} folder${collapsed === 1 ? '' : 's'} collapsed; pass a larger \`depth\` to expand` : ''
  }:`;
  // Send the header as plain text, then the tree itself in code-fenced blocks.
  await interaction.editReply(header);
  const blocks = paginate(lines, null);
  for (const block of blocks) {
    await interaction.followUp({ content: '```\n' + block + '\n```', ephemeral: true });
  }
}

async function handleSearch(interaction) {
  const query = interaction.options.getString('query').toLowerCase();
  const files = getAllFiles()
    .filter((f) => f.path.toLowerCase().includes(query))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (files.length === 0) {
    return interaction.editReply(`No files match \`${query}\`.`);
  }

  const lines = files.map((f) => `\`${f.path}\` — ${humanSize(f.size)}`);
  const blocks = paginate(lines, `**${files.length} match(es)** for \`${query}\`:`);

  await interaction.editReply(blocks[0]);
  for (const block of blocks.slice(1)) await interaction.followUp({ content: block, ephemeral: true });
}

// Like /search, but matches the FILENAME only (the last path segment) rather
// than the whole path.
async function handleFind(interaction) {
  const name = interaction.options.getString('name').toLowerCase();
  const files = getAllFiles()
    .filter((f) => f.path.split('/').pop().toLowerCase().includes(name))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (files.length === 0) {
    return interaction.editReply(`No files with a name matching \`${name}\`.`);
  }

  const lines = files.map((f) => `\`${f.path}\` — ${humanSize(f.size)}`);
  const blocks = paginate(lines, `**${files.length} file(s)** named like \`${name}\`:`);

  await interaction.editReply(blocks[0]);
  for (const block of blocks.slice(1)) await interaction.followUp({ content: block, ephemeral: true });
}

async function handleGet(interaction) {
  const filePath = interaction.options.getString('path').trim();
  const row = getFile(filePath);

  if (!row) {
    return interaction.editReply(`No file at \`${filePath}\`. Use \`/list\` to see available paths.`);
  }

  const maxBytes = discordConfig.maxUploadBytes || 25 * 1024 * 1024;
  if (row.size > maxBytes) {
    return interaction.editReply(
      `\`${filePath}\` is ${humanSize(row.size)}, which exceeds the Discord upload limit (${humanSize(maxBytes)}).`
    );
  }

  const stream = getReadStream(row.storage_id);
  const fileName = filePath.split('/').pop();
  const attachment = new AttachmentBuilder(stream, { name: fileName });

  await interaction.editReply({
    content: `📄 \`${filePath}\` (${humanSize(row.size)})`,
    files: [attachment],
  });
}

// ── attachment ingestion ──────────────────────────────────────────────────────

async function handleIncomingAttachments(message, log) {
  const maxBytes = discordConfig.maxUploadBytes || 25 * 1024 * 1024;
  const saved = [];
  const failed = [];

  for (const attachment of message.attachments.values()) {
    if (attachment.size > maxBytes) {
      failed.push(`\`${attachment.name}\` (${humanSize(attachment.size)} — too large)`);
      continue;
    }
    try {
      const buffer = await fetchAttachment(attachment.url, maxBytes);
      const name = safeName(attachment.name);
      const filePath = `${DISCORD_PREFIX}/${name}`;
      const result = await storeBuffer({
        filePath,
        fileName: name,
        buffer,
        source: `discord:${message.author.id}`,
      });
      saved.push(`\`${result.path}\` (${humanSize(result.size)}${result.replaced ? ', replaced' : ''})`);
      log?.info(
        { action: 'discord-upload', path: result.path, size: result.size, user: message.author.id },
        'file stored via discord'
      );
    } catch (err) {
      failed.push(`\`${attachment.name}\` (${err.message})`);
      log?.error({ err, file: attachment.name }, 'discord attachment store failed');
    }
  }

  if (saved.length || failed.length) {
    const embed = new EmbedBuilder().setTitle('simple-cloud — file ingest');
    if (saved.length) embed.addFields({ name: '✅ Saved', value: saved.join('\n').slice(0, 1024) });
    if (failed.length) embed.addFields({ name: '⚠️ Skipped', value: failed.join('\n').slice(0, 1024) });
    embed.setColor(failed.length && !saved.length ? 0xff5555 : 0x55cc77);
    await message.reply({ embeds: [embed] });
  }
}

// ── secure folder: status + lock/unlock ────────────────────────────────────────

// Free / total disk space on the volume holding storageDir. Returns null if
// statfs isn't available on this platform/Node build.
function diskSpace() {
  try {
    const st = fs.statfsSync(storageDir);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { total, free };
  } catch (_) {
    return null;
  }
}

async function handleStatus(interaction) {
  const s = lockService.status();

  const all = getAllFiles();
  const totalBytes = all.reduce((sum, f) => sum + (f.size || 0), 0);
  const disk = diskSpace();

  const embed = new EmbedBuilder()
    .setTitle('📊 simple-cloud server status')
    .setColor(s.locked ? 0xcc5555 : 0x55cc77)
    .addFields(
      { name: 'Files stored', value: String(all.length), inline: true },
      { name: 'Data size', value: humanSize(totalBytes), inline: true },
      {
        name: 'Disk free',
        value: disk ? `${humanSize(disk.free)} free of ${humanSize(disk.total)}` : 'unavailable',
        inline: true,
      },
      { name: 'Secure folder', value: `\`${s.prefix}\``, inline: false },
      { name: 'Lock state', value: s.locked ? '🔒 Locked' : '🔓 Unlocked', inline: true },
      { name: 'Secure files', value: String(s.filesInManifest), inline: true },
      { name: 'Archive present', value: s.archiveExists ? 'yes' : 'no', inline: true }
    )
    .setFooter({
      text: s.locked
        ? 'Send "unlock <password>" to restore the secure files.'
        : 'Send "lock <password>" to encrypt and hide the secure folder.',
    });
  await interaction.editReply({ embeds: [embed] });
}

// `lock <password>` — text command. The password is in the message body, so we
// delete the user's message immediately (best effort) to scrub it from the
// channel. The bot's own reply never echoes the password.
async function handleLockCommand(message, password, log) {
  await tryDeleteMessage(message);

  let notice;
  try {
    notice = await message.channel.send('🔒 Locking secure folder…');
  } catch (_) {
    notice = null;
  }

  try {
    const result = await lockService.lock(password);
    log?.info({ action: 'lock', count: result.lockedCount, user: message.author.id }, 'secure folder locked');
    const text = `🔒 Locked **${result.lockedCount}** file(s). They are now encrypted and have been removed from all clients.`;
    if (notice) await notice.edit(text);
    else await message.channel.send(text);
  } catch (err) {
    log?.error({ err, action: 'lock' }, 'lock failed');
    const text = `❌ Lock failed: ${err.message}`;
    if (notice) await notice.edit(text);
    else await message.channel.send(text);
  }
}

async function handleUnlockCommand(message, password, log) {
  await tryDeleteMessage(message);

  let notice;
  try {
    notice = await message.channel.send('🔓 Unlocking secure folder…');
  } catch (_) {
    notice = null;
  }

  try {
    const result = await lockService.unlock(password);
    log?.info({ action: 'unlock', count: result.restoredCount, user: message.author.id }, 'secure folder unlocked');
    const text = `🔓 Unlocked **${result.restoredCount}** file(s). Clients will download them on the next sync.`;
    if (notice) await notice.edit(text);
    else await message.channel.send(text);
  } catch (err) {
    log?.error({ err, action: 'unlock' }, 'unlock failed');
    const text = `❌ Unlock failed: ${err.message}`;
    if (notice) await notice.edit(text);
    else await message.channel.send(text);
  }
}

async function tryDeleteMessage(message) {
  try {
    if (message.deletable) await message.delete();
  } catch (_) {
    /* missing Manage Messages permission, or a DM — ignore */
  }
}

// ── command registration ───────────────────────────────────────────────────────

async function registerCommands(log) {
  const { token, clientId, guildId } = discordConfig;
  const rest = new REST({ version: '10' }).setToken(token);

  if (guildId) {
    // Guild commands register instantly — preferred for a private bot.
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    log?.info({ guildId }, 'discord: registered guild slash commands');
  } else {
    // Global commands can take up to an hour to propagate.
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    log?.info('discord: registered global slash commands');
  }
}

// ── entry point ────────────────────────────────────────────────────────────────

async function startDiscordBot(log) {
  const { enabled, token, clientId } = discordConfig;

  if (!enabled) return null;
  if (!token || !clientId) {
    log?.warn('discord: enabled but token/clientId missing — bot not started');
    return null;
  }

  await registerCommands(log);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel], // needed to receive DMs
  });

  client.once('ready', () => {
    log?.info({ user: client.user.tag }, 'discord: bot logged in');
  });

  // Slash command dispatch
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (!isAllowed(interaction)) {
      return interaction.reply({ content: '⛔ You are not authorized to use this bot here.', ephemeral: true });
    }

    try {
      await interaction.deferReply({ ephemeral: true });
      switch (interaction.commandName) {
        case 'list':
          await handleList(interaction);
          break;
        case 'tree':
          await handleTree(interaction);
          break;
        case 'search':
          await handleSearch(interaction);
          break;
        case 'find':
          await handleFind(interaction);
          break;
        case 'get':
          await handleGet(interaction);
          break;
        case 'status':
          await handleStatus(interaction);
          break;
        default:
          await interaction.editReply('Unknown command.');
      }
    } catch (err) {
      log?.error({ err, command: interaction.commandName }, 'discord command failed');
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(`Error: ${err.message}`).catch(() => {});
      } else {
        await interaction.reply({ content: `Error: ${err.message}`, ephemeral: true }).catch(() => {});
      }
    }
  });

  // Text commands (lock/unlock) + attachment ingestion
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // `lock <password>` / `unlock <password>` text commands. Matched before the
    // allowlist short-circuit so we can still scrub the password from the
    // channel even for unauthorized users.
    const lockMatch = /^\s*(lock|unlock)\s+(.+?)\s*$/i.exec(message.content || '');
    if (lockMatch) {
      const action = lockMatch[1].toLowerCase();
      const password = lockMatch[2];

      if (!isAllowed(message)) {
        // Scrub the password even though we won't act on it.
        await tryDeleteMessage(message);
        await message.channel
          .send('⛔ You are not authorized to use this bot here.')
          .catch(() => {});
        return;
      }

      if (action === 'lock') await handleLockCommand(message, password, log);
      else await handleUnlockCommand(message, password, log);
      return;
    }

    // Attachment ingestion
    if (message.attachments.size === 0) return;
    if (!isAllowed(message)) return; // silently ignore unauthorized

    try {
      await handleIncomingAttachments(message, log);
    } catch (err) {
      log?.error({ err }, 'discord attachment ingest failed');
      await message.reply(`Error storing files: ${err.message}`).catch(() => {});
    }
  });

  await client.login(token);
  return client;
}

module.exports = { startDiscordBot };
