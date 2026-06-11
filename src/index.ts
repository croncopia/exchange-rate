import aggregate from "./aggregate"
import distribute from "./distribute"

//import 'dotenv/config'

async function main() {

    const data = await aggregate()
    const result = await distribute(data)
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
