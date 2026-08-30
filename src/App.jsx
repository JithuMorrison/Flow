import { useState } from 'react'
import heroImg from './assets/hero.png'
import reactLogo from './assets/react.svg'
import viteLogo from './assets/vite.svg'
import './App.css'
import AtlasEngine from './WorldGen'

function App() {
  const [count, setCount] = useState(0)

  return (
    <>
      <AtlasEngine/>
    </>
  )
}

export default App
