import pkg from 'bcryptjs'
const { hash } = pkg
import { PrismaClient, admin_role, player_role, skill_level, booking_status, booking_type, payment_status, payment_gateway } from '../generated/prisma/index.js'

const prisma = new PrismaClient()

async function hashPassword(password: string) {
  return hash(password, 12)
}

function getRandomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function getRandomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

async function main() {
  console.log('🧹 Cleaning existing test data...')
  
  // Order matters for deletion (foreign keys)
  await prisma.reviews.deleteMany({})
  await prisma.payments.deleteMany({})
  await prisma.match_group_members.deleteMany({})
  await prisma.match_groups.deleteMany({})
  await prisma.friendships.deleteMany({})
  await prisma.bookings.deleteMany({})
  await prisma.pricing_rules.deleteMany({})
  await prisma.courts.deleteMany({})
  await prisma.venues.deleteMany({})
  await prisma.owners.deleteMany({})
  await prisma.penalty_history.deleteMany({})
  await prisma.users.deleteMany({})
  // We keep admins as they represent platform staff

  console.log('🚀 Starting MASSIVE seeding...')

  const passwordHash = await hashPassword('password123')

  // 1. Seed Admins
  console.log('  - Seeding Admins...')
  const adminEmails = ['admin@futsmandu.com', 'staff@futsmandu.com']
  const admins = [
    { email: 'admin@futsmandu.com', name: 'Super Admin', role: 'SUPER_ADMIN' as admin_role },
    { email: 'staff@futsmandu.com', name: 'Staff Member', role: 'ADMIN' as admin_role },
  ]

  for (const a of admins) {
    await prisma.admins.upsert({
      where: { email: a.email },
      update: {},
      create: { ...a, password_hash: passwordHash },
    })
  }

  // 2. Seed Owners & Venues
  console.log('  - Seeding Owners, Venues, and Courts...')
  const venueThemes = [
    'Arena', 'Village', 'Empire', 'Velocity', 'Base',
    'Goal', 'Kick', 'Power', 'Strike', 'Pro',
    'Elite', 'Prime', 'Supreme', 'United', 'City',
    'Star', 'Urban', 'Central', 'Classic', 'Royal'
  ]
  const areas = ['Baluwatar', 'Lazimpat', 'Hattigauda', 'Ratopul', 'Baneshwor', 'Patan', 'Thamel', 'Boudha', 'Jhamel', 'Koteshwor']


  const owners = []
  for (let i = 0; i < 50; i++) {
    const owner = await prisma.owners.create({
      data: {
        email: `owner${i + 1}@futsal.com`,
        phone: `980100000${i}`,
        password_hash: passwordHash,
        name: `Owner ${i + 1}`,
        business_name: `Business ${i + 1} Pvt Ltd`,
        is_verified: true,
        isKycApproved: true,
      },
    })
    owners.push(owner)

    const area = getRandomItem(areas)
    const venueName = `${getRandomItem(venueThemes)} Futsal ${i + 1}`
    const venueSlug = `venue-${i+1}-${Math.random().toString(36).substring(7)}`
    
    const venue = await prisma.venues.create({
      data: {
        owner_id: owner.id,
        name: venueName,
        slug: venueSlug,
        address: { city: 'Kathmandu', area: area, street: 'Main St' },
        latitude: 27.7 + i * 0.01,
        longitude: 85.3 + i * 0.01,
        amenities: ['Parking', 'Cafe', 'Shower'],
        cover_image_url: `https://picsum.photos/seed/venue${i}/800/600`,
        is_active: true,
        is_verified: true,
        isApproved: true,
      },
    })

    const numCourts = getRandomInt(2, 3)
    for (let c = 0; c < numCourts; c++) {
      const type = getRandomItem(['5v5', '7v7', '9v9'])
      await prisma.courts.create({
        data: {
          venue_id: venue.id,
          name: `Court ${String.fromCharCode(65 + c)} (${type})`,
          court_type: type,
          capacity: type === '5v5' ? 10 : (type === '7v7' ? 14 : 18),
          open_time: '06:00',
          close_time: '23:00',
        },
      })
    }
  }

  // 3. Seed Players
  console.log('  - Seeding Players...')
  const players = []
  for (let i = 0; i < 200; i++) {
    const player = await prisma.users.create({
      data: {
        email: `player${i + 1}@gmail.com`,
        phone: `98400000${i.toString().padStart(2, '0')}`,
        name: `Player ${i + 1}`,
        password_hash: passwordHash,
        is_verified: true,
        skill_level: getRandomItem(['beginner', 'intermediate', 'advanced'] as skill_level[]),
      },
    })
    players.push(player)
  }

  // 4. Seed Bookings & Payments & Reviews
  console.log('  - Generating 1000+ Bookings...')
  const venues = await prisma.venues.findMany({ include: { courts: true } })
  const today = new Date()

  for (let i = 0; i < 1000; i++) {
    const venue = getRandomItem(venues)
    const court = getRandomItem(venue.courts)
    const player = getRandomItem(players)
    
    const bookingDate = new Date(today)
    bookingDate.setDate(today.getDate() + getRandomInt(-30, 30))
    
    const startTimeInt = getRandomInt(6, 21)
    const startTime = `${startTimeInt.toString().padStart(2, '0')}:00`
    const endTime = `${(startTimeInt + 1).toString().padStart(2, '0')}:00`

    const statusList: booking_status[] = ['CONFIRMED', 'CANCELLED', 'COMPLETED', 'PENDING_PAYMENT', 'EXPIRED']
    const status = getRandomItem(statusList)
    
    const booking = await prisma.bookings.create({
      data: {
        player_id: player.id,
        court_id: court.id,
        venue_id: venue.id,
        booking_date: bookingDate,
        start_time: startTime,
        end_time: endTime,
        duration_mins: 60,
        base_price: 1500,
        total_amount: 1500,
        status,
        booking_type: 'online',
        created_by: player.id,
      },
    })

    if (status === 'CONFIRMED' || status === 'COMPLETED') {
      await prisma.payments.create({
        data: {
          booking_id: booking.id,
          player_id: player.id,
          amount: 1500,
          gateway: getRandomItem(['KHALTI', 'ESEWA'] as payment_gateway[]),
          status: 'SUCCESS',
          completed_at: new Date(),
        },
      })

      if (status === 'COMPLETED' && Math.random() > 0.5) {
        await prisma.reviews.create({
          data: {
            booking_id: booking.id,
            venue_id: venue.id,
            player_id: player.id,
            rating: getRandomInt(3, 5),
            comment: getRandomItem(['Great game!', 'Pitch was nice.', 'Perfect lighting.', 'A bit expensive but worth it.']),
            is_approved: true,
          },
        })
      }
    }
  }

  // 5. Seed Friendships
  console.log('  - Seeding Friendships...')
  for (let i = 0; i < 250; i++) {
    const p1 = getRandomItem(players)
    const p2 = getRandomItem(players)
    if (p1.id === p2.id) continue

    await prisma.friendships.create({
      data: {
        requester_id: p1.id,
        recipient_id: p2.id,
        status: 'accepted',
      },
    }).catch(() => {}) // Skip if duplicate
  }

  console.log('✅ MASSIVE Seed completed!')
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
