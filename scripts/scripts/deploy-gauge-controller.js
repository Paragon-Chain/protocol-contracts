// scripts/deploy-gauge-controller.js
require('dotenv').config()
const { ethers } = require('hardhat')

const VEXPGN = process.env.VEXPGN || '0x357Ba6D74b976d5c15C02b76Fbfa58c6Ca01d1AC' // veXPGN
const OWNER  = process.env.GAUGE_OWNER || '' // leave blank -> deployer

async function deployed(c){ if(c.waitForDeployment){await c.waitForDeployment(); return c.getAddress()} await c.deployed(); return c.address }

async function main () {
  const [deployer] = await ethers.getSigners()
  const owner = OWNER || deployer.address
  console.log('Deployer:', deployer.address, 'Owner:', owner)

  const C = await ethers.getContractFactory('GaugeController')
  const c = await C.deploy(VEXPGN, owner)
  const addr = await deployed(c)
  console.log('+ GaugeController @', addr)
}
main().catch(e=>{console.error(e);process.exit(1)})
