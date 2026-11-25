import { CHART_METRES, fitView, toChart } from '../../world/sea/chart.js';
import { canSetCourse } from './model.js';

const PANEL = 'seaChart';
const WIDTH = 800, HEIGHT = 400;
const hasPosition = (p) => Number.isFinite(p?.x) && Number.isFinite(p?.z);

export function installChartPanel(api) {
  let coast = null, state = null, selected = '', route = null;
  let ui = null, transform = null, local = false, busy = false, notice = '', generation = 0;
  const vessel = () => state?.vessel;
  const currentPort = () => vessel() ? vessel().docked : state?.port?.id;
  const focusPort = () => coast?.ports.find((p) => p.id === (currentPort() || selected));

  function pick(id) {
    selected = id;
    route = null;
    notice = '';
    if (ui) ui.ports.value = selected;
    draw();
  }

  function draw() {
    if (!ui || api.panel !== PANEL && !ui.canvas.isConnected) return;
    const { canvas, status, plot, sail, zoom, retry } = ui;
    retry.hidden = !!coast || busy;
    const me = vessel(), home = focusPort();
    const aim = hasPosition(me) ? toChart(me.x, me.z) : home;
    zoom.disabled = !aim;
    zoom.textContent = local ? 'Whole bay' : 'Local waters';
    plot.disabled = busy || !currentPort() || !selected || selected === currentPort();
    plot.hidden = !!me && !me.docked;
    sail.hidden = !canSetCourse(state);
    sail.disabled = busy || !selected || me?.course?.to === selected;
    status.textContent = notice || (!coast ? 'Reading the sea chart…' : route ? 'Plotted passage · ' + (route.metres / 1000).toFixed(1) + ' km' : '');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#112632';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    if (!coast) return;
    const bounds = local && aim ? { u0: aim.u - 23, u1: aim.u + 23, v0: aim.v - 12, v1: aim.v + 12 } : coast.bounds;
    transform = fitView(bounds, WIDTH, HEIGHT, 12);
    const screen = transform.toScreen;
    ctx.beginPath();
    for (const ring of coast.coast) {
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = screen(...ring[i]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
    ctx.fillStyle = '#435956';
    ctx.fill('evenodd');
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = '#81948c';
    ctx.stroke();

    const track = me?.course?.points?.length
      ? [me, ...me.course.points]
      : route?.points;
    if (track?.length) {
      ctx.beginPath();
      track.forEach((p, i) => {
        const [x, y] = screen(p.x / CHART_METRES, p.z / CHART_METRES);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = '#edcf8c'; ctx.lineWidth = 2.4;
      ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    }

    for (const p of coast.ports) {
      const [x, y] = screen(p.u, p.v);
      if (x < 2 || y < 2 || x >= WIDTH - 2 || y >= HEIGHT - 2) continue;
      const marked = p.id === selected || p.id === currentPort();
      ctx.beginPath(); ctx.arc(x, y, marked ? 4.5 : 2.3, 0, Math.PI * 2);
      ctx.fillStyle = marked ? '#f1d59b' : '#b8cbcc'; ctx.fill();
      if (marked || local) {
        ctx.font = '15px Georgia, serif';
        ctx.textAlign = x > WIDTH - 140 ? 'right' : 'left';
        ctx.lineWidth = 3; ctx.strokeStyle = '#10222b';
        const tx = x + (ctx.textAlign === 'right' ? -7 : 7), ty = Math.max(17, y - 6);
        ctx.strokeText(p.name, tx, ty); ctx.fillStyle = '#eef0de'; ctx.fillText(p.name, tx, ty);
      }
    }
    if (hasPosition(me)) {
      const [x, y] = screen(aim.u, aim.v);
      ctx.save(); ctx.translate(x, y); ctx.rotate(me.yaw || 0);
      ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 4); ctx.lineTo(-6, 7); ctx.closePath();
      ctx.fillStyle = '#cdf3ff'; ctx.fill(); ctx.strokeStyle = '#152c39'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();
    }
    ctx.font = '14px sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = '#d9e4e6'; ctx.fillText('↑ N', WIDTH - 9, 20);
    canvas.setAttribute('aria-label', 'Chart of ' + coast.world.label + (me ? ', showing ' + me.name : '') + (route ? ', with plotted passage' : ''));
  }

  async function request(to = null) {
    if (busy) return;
    const version = generation;
    busy = true; notice = to ? 'Plotting the water route…' : 'Reading the sea chart…'; draw();
    try {
      const res = await api.act('sailing.chart', to ? { to } : {}, { quiet: true });
      if (!res?.ok) throw new Error(res?.error || 'The sea chart is unavailable.');
    } catch (error) {
      if (generation === version) { busy = false; notice = error.message; draw(); }
    }
  }

  function listPorts() {
    if (!ui || !coast) return;
    const choices = [new Option('Choose a port…', '')];
    for (const p of [...coast.ports].sort((a, b) => a.name.localeCompare(b.name))) {
      choices.push(new Option(p.name + (p.region ? ', ' + p.region : ''), p.id));
    }
    ui.ports.replaceChildren(...choices);
    ui.ports.value = selected;
  }

  function render(root) {
    const heading = document.createElement('h2');
    heading.className = 'tsv-h'; heading.textContent = 'Sea chart';
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH; canvas.height = HEIGHT; canvas.className = 'sail-chart-canvas';
    canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Sea chart');
    const row = document.createElement('div'); row.className = 'tsv-row sail-chart-controls';
    const ports = document.createElement('select');
    ports.setAttribute('aria-label', 'Chart destination'); ports.onchange = () => pick(ports.value);
    row.append(ports);
    function button(label, action) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'sail-btn'; b.textContent = label; b.onclick = action; row.append(b); return b;
    }
    const plot = button('Plot passage', () => request(selected));
    const sail = button('Set course', async () => {
      if (!canSetCourse(state) || !selected || busy) return;
      const destination = selected, version = generation;
      busy = true; notice = ''; draw();
      try {
        const result = await api.act('sailing.course', { portId: destination }, { quiet: true });
        if (version === generation) notice = result?.ok
          ? 'Course set for ' + coast.ports.find(p => p.id === destination).name + '.'
          : result?.error || 'The course could not be set.';
      } catch (error) {
        if (version === generation) notice = error.message;
      } finally {
        if (version === generation) { busy = false; draw(); }
      }
    });
    const zoom = button('Local waters', () => { local = !local; draw(); });
    const retry = button('Read chart', () => request());
    const status = document.createElement('p'); status.className = 'tsv-dim'; status.setAttribute('role', 'status');
    canvas.onclick = (e) => {
      if (!coast || !transform) return;
      const rect = canvas.getBoundingClientRect();
      let nearest = null, distance = 14;
      for (const p of coast.ports) {
        const [x, y] = transform.toScreen(p.u, p.v);
        const d = Math.hypot((e.clientX - rect.left) * WIDTH / rect.width - x, (e.clientY - rect.top) * HEIGHT / rect.height - y);
        if (d < distance) { nearest = p; distance = d; }
      }
      if (nearest) pick(nearest.id);
    };
    root.replaceChildren(heading, canvas, row, status);
    ui = { canvas, ports, status, plot, sail, zoom, retry };
    listPorts(); draw();
    if (!coast && !busy) void request();
  }

  api.registerPanel(PANEL, 'Sea chart', render, { watch: 'none' });
  api.on('event', (e) => {
    if (e?.kind === 'sailing.chart' && e.chart?.bounds) { coast = e.chart; busy = false; notice = ''; listPorts(); }
    else if (e?.kind === 'sailing.chartRoute') { busy = false; notice = ''; if (e.to === selected) route = e; }
    else if (e?.kind === 'sailing.chartError') { busy = false; notice = e.error; }
    else if (e?.kind === 'sailing.state') {
      const previous = vessel()?.id;
      state = e;
      if (previous !== vessel()?.id && !vessel()?.docked) route = null;
    } else return;
    if (api.panel === PANEL) draw();
  });
  api.on('connection', (s) => {
    if (s === 'lost' || s === 'closed') {
      generation++; coast = null; route = null; state = null; busy = false; notice = 'Connection lost.';
      if (api.panel === PANEL) draw();
    } else if (s === 'online' && api.panel === PANEL && !coast) void request();
  });
}
