const settings = require('../core/settings');

module.exports = {
  name: 'view',
  description: 'Toggle automatic status viewing',
  async run(ctx) {
    const [action, ...extraArgs] = ctx.args;

    if (!action) {
      await ctx.reply(`👁️ Auto-view is currently ${settings.get('autoView') ? 'ON' : 'OFF'}.`);
      return;
    }

    if (extraArgs.length > 0) {
      await ctx.reply('Usage: !view on|off');
      return;
    }

    if (action.toLowerCase() === 'on') {
      settings.set('autoView', true);
      await ctx.reply('👁️ Auto-view is now ON.');
      return;
    }

    if (action.toLowerCase() === 'off') {
      settings.set('autoView', false);
      settings.set('autoReact', false);
      await ctx.reply('👁️ Auto-view is now OFF. (Auto-react also disabled).');
      return;
    }

    await ctx.reply('Usage: !view on|off');
  }
};
