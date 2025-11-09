async function j(url){ const r = await fetch(url); if(!r.ok) throw new Error(url+" "+r.status); return r.json(); }

async function loadTrends(taxonId){
  const q = taxonId ? `?taxon_id=${encodeURIComponent(taxonId)}` : "";
  const annual = await j(`/api/trends/annual${q}`);
  Plotly.newPlot('annual', [{
    x: annual.map(r=>r.year), y: annual.map(r=>r.count),
    type: 'scatter', mode: 'lines+markers'
  }], { title: 'Annual trend', xaxis:{title:'Year'}, yaxis:{title:'Count'} });

  const seasonal = await j(`/api/trends/seasonal${q}`);
  Plotly.newPlot('seasonal', [{
    x: seasonal.map(r=>r.month), y: seasonal.map(r=>r.count),
    type: 'bar'
  }], { title: 'Seasonality', xaxis:{title:'Month'}, yaxis:{title:'Count'} });
}

window.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('load');
  const input = document.getElementById('taxon');
  btn.addEventListener('click', () => loadTrends(input.value.trim()));
  loadTrends(""); // auto au chargement
});
