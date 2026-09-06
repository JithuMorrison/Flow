import { BrowserRouter, Routes, Route } from 'react-router-dom'
import AtlasEngine from './WorldGen'
import MapViewer from './MapViewer'
import FlowEntry from './FlowEntry'
import FlowRegister from './Register'
import CreatureViewer from './SpeciesCreator'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<FlowEntry />} />
        <Route path="/register" element={<FlowRegister />} />
        <Route path="/engine" element={<AtlasEngine />} />
        <Route path="/viewer" element={<MapViewer />} />
        <Route path="/creature" element={<CreatureViewer />} />
        <Route path="*" element={<h1>404 Not Found</h1>} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
