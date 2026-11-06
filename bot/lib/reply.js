async function reply(ctx, text) {
  return ctx.sock.sendMessage(ctx.chatId, { text }, { quoted: ctx.msg });
}

async function replyMedia(ctx, type, buffer, opts = {}) {
  const supportedTypes = ['image', 'video', 'audio', 'document'];
  if (!supportedTypes.includes(type)) {
    throw new TypeError(`Unsupported media type: ${type}`);
  }

  return ctx.sock.sendMessage(
    ctx.chatId,
    { [type]: buffer, ...opts },
    { quoted: ctx.msg }
  );
}

module.exports = {
  reply,
  replyMedia
};
