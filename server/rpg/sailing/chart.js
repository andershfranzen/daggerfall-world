// Coast workers may still be sounding berths when someone opens the chart. Answer privately once the data is ready.
// The request itself finishes synchronously so a crossing never holds a gameplay transaction open.
export function installChart(ctx, getCoast, ashorePort) {
  const pending = new WeakSet();
  ctx.onAction('sailing.chart', (player, args) => {
    if (pending.has(player)) throw new Error('Your chart is being prepared.');
    const to = args?.to;
    const vessel = ctx.services.sailing.aboard(player);
    const from = vessel ? vessel.docked : ashorePort(player)?.id;
    if (to != null) {
      if (!from) throw new Error('Plot a passage from a port or a moored ship.');
      if (typeof to !== 'string' || to === from) throw new Error('Choose another port on the chart.');
    }
    ctx.afterCommit(async () => {
      pending.add(player);
      let event;
      try {
        const coast = await getCoast();
        if (to == null) {
          // coast.js traces the chart in its worker (chartAsync); berths are planned on demand, so there is no
          // all-harbours promise to wait for.
          await coast.ready;
          if (typeof coast.chartAsync !== 'function') throw new Error('The sea chart is not available on this server.');
          const chart = await coast.chartAsync();
          event = { kind: 'sailing.chart', chart };
        } else {
          if (!coast.portOf(from) || !coast.portOf(to)) throw new Error('Choose a charted port.');
          const route = await coast.routeAsync(from, to);
          if (!route) throw new Error('There is no navigable route between these berths.');
          event = { kind: 'sailing.chartRoute', from, to, points: route.points, metres: route.metres };
        }
      } catch (e) {
        event = { kind: 'sailing.chartError', to, error: e.message };
      } finally {
        pending.delete(player);
      }
      if (ctx.players.get(player.id) === player) ctx.notify(player, { ...event, silent: true });
    });
  });
}
